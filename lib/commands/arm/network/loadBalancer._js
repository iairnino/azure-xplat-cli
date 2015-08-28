/**
 * Copyright (c) Microsoft.  All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var __ = require('underscore');
var util = require('util');
var utils = require('../../../util/utils');
var $ = utils.getLocaleString;
var constants = require('./constants');
var lbShowUtil = require('./lbShowUtil');
var tagUtils = require('../tag/tagUtils');
var EndPointUtil = require('../../../util/endpointUtil');
var PublicIp = require('./publicIp');
var Subnet = require('./subnet');

function LoadBalancer(cli, networkResourceProviderClient) {
  this.networkResourceProviderClient = networkResourceProviderClient;
  this.publicIpCrud = new PublicIp(cli, networkResourceProviderClient);
  this.subnetCrud = new Subnet(cli, networkResourceProviderClient);
  this.endpointUtil = new EndPointUtil();
  this.output = cli.output;
  this.interaction = cli.interaction;
}

__.extend(LoadBalancer.prototype, {
  create: function (resourceGroupName, lbName, location, options, _) {
    var self = this;
    var lb = self.get(resourceGroupName, lbName, _);
    if (lb) {
      throw new Error(util.format($('A load balancer with name "%s" already exists in the resource group "%s"'), lbName, resourceGroupName));
    }

    var lbProfile = {
      location: location
    };

    if (options.tags) {
      lbProfile.tags = tagUtils.buildTagsParameter(null, options);
    }

    var progress = self.interaction.progress(util.format($('Creating load balancer "%s"'), lbName));
    try {
      self.networkResourceProviderClient.loadBalancers.createOrUpdate(resourceGroupName, lbName, lbProfile, _);
    } finally {
      progress.end();
    }
    self.show(resourceGroupName, lbName, options, _);
  },

  list: function (resourceGroupName, _) {
    var self = this;
    var progress = self.interaction.progress($('Getting the load balancers'));
    var lbs = null;
    try {
      lbs = self.networkResourceProviderClient.loadBalancers.list(resourceGroupName, _);
    } finally {
      progress.end();
    }

    self.interaction.formatOutput(lbs.loadBalancers, function (outputData) {
      if (outputData.length === 0) {
        self.output.warn($('No load balancers found'));
      } else {
        self.output.table(outputData, function (row, lb) {
          row.cell($('Name'), lb.name);
          row.cell($('Location'), lb.location);
        });
      }
    });
  },

  show: function (resourceGroupName, lbName, options, _) {
    var self = this;
    var lb = self.get(resourceGroupName, lbName, _);

    if (lb) {
      if (!__.isEmpty(lb.loadBalancer.frontendIpConfigurations)) {
        for (var i = 0; i < lb.loadBalancer.frontendIpConfigurations.length; i++) {
          var frontendIpConf = lb.loadBalancer.frontendIpConfigurations[i];
          if (frontendIpConf.publicIpAddress) {
            var uriParts = utils.parseResourceReferenceUri(frontendIpConf.publicIpAddress.id);
            var publicip = self.publicIpCrud.get(uriParts.resourceGroupName, uriParts.resourceName, _);
            frontendIpConf.publicIpAddress.publicIpAllocationMethod = publicip.publicIpAllocationMethod;
            if (publicip.dnsSettings && publicip.dnsSettings.fqdn) {
              frontendIpConf.fqdn = publicip.dnsSettings.fqdn;
            }
            if (publicip.ipAddress) {
              frontendIpConf.publicIpAddress.actualPublicIpAddress = publicip.ipAddress;
            }
          }
        }
      }

      self.interaction.formatOutput(lb.loadBalancer, function (lb) {
        lbShowUtil.show(lb, self.output);
      });

      return;
    }

    if (self.output.format().json) {
      self.output.json({});
    } else {
      self.output.warn(util.format($('A load balancer with name "%s" not found in the resource group "%s"'), lbName, resourceGroupName));
    }
  },

  get: function (resourceGroupName, lbName, _, message) {
    var self = this;
    message = message || util.format($('Looking up the load balancer "%s"'), lbName);
    var progress = self.interaction.progress(message);
    try {
      var lb = self.networkResourceProviderClient.loadBalancers.get(resourceGroupName, lbName, _);
      return lb;
    } catch (e) {
      if (e.code === 'ResourceNotFound') {
        return null;
      }
      throw e;
    } finally {
      progress.end();
    }
  },

  delete: function (resourceGroupName, lbName, options, _) {
    var self = this;
    var lb = self.get(resourceGroupName, lbName, _);
    if (!lb) {
      throw new Error(util.format($('A load balancer with name "%s" not found in the resource group "%s"'), lbName, resourceGroupName));
    }

    if (!options.quiet && !self.interaction.confirm(util.format($('Delete load balancer "%s"? [y/n] '), lbName), _)) {
      return;
    }

    var progress = self.interaction.progress(util.format($('Deleting load balancer "%s"'), lbName));
    try {
      self.networkResourceProviderClient.loadBalancers.deleteMethod(resourceGroupName, lbName, _);
    } finally {
      progress.end();
    }
  },

  update: function (resourceGroupName, lbName, lbProfile, _) {
    var self = this;
    var progress = self.interaction.progress(util.format($('Updating load balancer "%s"'), lbName));
    try {
      self.networkResourceProviderClient.loadBalancers.createOrUpdate(resourceGroupName, lbName, lbProfile, _);
    } finally {
      progress.end();
    }
  },

  /**
   * Commands to manage Probes
   */

  createProbe: function (resourceGroupName, lbName, probeName, options, _) {
    var self = this;
    var probeProfile = self._parseProbe(probeName, options, true);
    var lb = self.get(resourceGroupName, lbName, _);
    if (!lb) {
      throw new Error(util.format($('A load balancer with name "%s" not found in the resource group "%s"'), lbName, resourceGroupName));
    }

    var probe = utils.findFirstCaseIgnore(lb.loadBalancer.probes, {
      name: probeName
    });
    if (probe) {
      self.output.error(util.format($('A probe with name "%s" already exist'), probeName));
    } else {
      lb.loadBalancer.probes.push(probeProfile);
      self.update(resourceGroupName, lbName, lb.loadBalancer, _);
    }
  },

  setProbe: function (resourceGroupName, lbName, probeName, options, _) {
    var self = this;
    var probeProfile = self._parseProbe(probeName, options, false);
    var lb = self.get(resourceGroupName, lbName, _);
    if (!lb) {
      throw new Error(util.format($('A load balancer with name "%s" not found in the resource group "%s"'), lbName, resourceGroupName));
    }

    var probe = utils.findFirstCaseIgnore(lb.loadBalancer.probes, {
      name: probeName
    });
    if (probe) {
      if (options.newProbeName) probe.name = probeProfile.name;
      if (options.port) probe.port = probeProfile.port;
      if (options.path) probe.requestPath = probeProfile.requestPath;
      if (options.interval) probe.intervalInSeconds = probeProfile.intervalInSeconds;
      if (options.count) probe.numberOfProbes = probeProfile.numberOfProbes;
      if (options.protocol) {
        probe.protocol = probeProfile.protocol;
        if (options.protocol.toLowerCase() === self.endpointUtil.protocols.TCP) {
          delete probe.requestPath;
        }
      }
      self.update(resourceGroupName, lbName, lb.loadBalancer, _);
    } else {
      self.output.error(util.format($('A probe with name "%s" not found'), probeName));
    }
  },

  listProbes: function (resourceGroupName, lbName, options, _) {
    var self = this;
    var lb = self.get(resourceGroupName, lbName, _);
    if (!lb) {
      throw new Error(util.format($('A load balancer with name "%s" not found in the resource group "%s"'), lbName, resourceGroupName));
    }

    var probes = lb.loadBalancer.probes;

    self.interaction.formatOutput(probes, function (outputData) {
      if (outputData.length !== 0) {
        self.output.table(outputData, function (row, probe) {
          row.cell($('Name'), probe.name);
          row.cell($('Protocol'), probe.protocol);
          row.cell($('Port'), probe.port);
          row.cell($('Path'), probe.requestPath || '');
          row.cell($('Interval'), probe.intervalInSeconds);
          row.cell($('Count'), probe.numberOfProbes);
        });
      } else {
        if (self.output.format().json) {
          self.output.json([]);
        } else {
          self.output.warn($('No probes found'));
        }
      }
    });
  },

  deleteProbe: function (resourceGroupName, lbName, probeName, options, _) {
    var self = this;
    var lb = self.get(resourceGroupName, lbName, _);
    if (!lb) {
      throw new Error(util.format($('A load balancer with name "%s" not found in the resource group "%s"'), lbName, resourceGroupName));
    }

    var index = utils.indexOfCaseIgnore(lb.loadBalancer.probes, {
      name: probeName
    });
    if (index !== null) {
      if (!options.quiet && !self.interaction.confirm(util.format($('Delete a probe "%s?" [y/n] '), probeName), _)) {
        return;
      }
      lb.loadBalancer.probes.splice(index, 1);
      self.update(resourceGroupName, lbName, lb.loadBalancer, _);
    } else {
      self.output.error(util.format($('A probe with name "%s" not found'), probeName));
    }
  },

  /**
   * Commands to manage Frontend IP configurations
   */

  createFrontendIP: function (resourceGroupName, lbName, ipConfigName, options, _) {
    var self = this;
    var frontendIpConfResult = self._getFrontendIP(resourceGroupName, lbName, ipConfigName, _);
    var frontendIpConf = frontendIpConfResult.object;
    if (frontendIpConf) {
      throw new Error(util.format($('Frontend IP configuration "%s" already exists in the load balancer "%s"'), ipConfigName, lbName));
    }

    var lb = frontendIpConfResult.loadBalancer;
    var frontendIPConf = {
      name: ipConfigName
    };

    frontendIPConf = self._parseFrontendIP(resourceGroupName, frontendIPConf, options, _);
    lb.frontendIpConfigurations.push(frontendIPConf);

    var progress = self.interaction.progress(util.format($('Creating frontend IP configuration "%s"'), ipConfigName));
    try {
      self.networkResourceProviderClient.loadBalancers.createOrUpdate(resourceGroupName, lbName, lb, _);
    } finally {
      progress.end();
    }

    var newFrontendIpConf = self._getFrontendIP(resourceGroupName, lbName, ipConfigName, _).object;
    self.showFrontendIP(newFrontendIpConf);
  },

  setFrontendIP: function (resourceGroupName, lbName, ipConfigName, options, _) {
    var self = this;
    var frontendIpConfResult = self._getFrontendIP(resourceGroupName, lbName, ipConfigName, _);
    var frontendIPConf = frontendIpConfResult.object;
    if (!frontendIPConf) {
      throw new Error(util.format($('Frontend IP configuration "%s" not found in the load balancer "%s"'), ipConfigName, lbName));
    }

    var lb = frontendIpConfResult.loadBalancer;
    frontendIPConf = self._parseFrontendIP(resourceGroupName, frontendIPConf, options, _);
    lb.frontendIpConfigurations[frontendIpConfResult.index] = frontendIPConf;

    self.update(resourceGroupName, lbName, lb, _);
    var newFrontendIpConf = self._getFrontendIP(resourceGroupName, lbName, ipConfigName, _).object;
    self.showFrontendIP(newFrontendIpConf);
  },

  listFrontendIPs: function (resourceGroupName, lbName, options, _) {
    var self = this;
    var lb = self.get(resourceGroupName, lbName, _);

    if (!lb) {
      throw new Error(util.format($('A load balancer with name "%s" not found in the resource group "%s"'), lbName, resourceGroupName));
    }

    var ipConfigurations = lb.loadBalancer.frontendIpConfigurations;
    self.interaction.formatOutput(ipConfigurations, function (outputData) {
      if (outputData.length !== 0) {
        self.output.table(outputData, function (row, fip) {
          row.cell($('Name'), fip.name);
          row.cell($('Provisioning state'), fip.provisioningState);
          row.cell($('Private IP allocation method'), fip.privateIpAllocationMethod);
          row.cell($('Subnet'), fip.subnet ? fip.subnet.id : '');
        });
      } else {
        if (self.output.format().json) {
          self.output.json([]);
        } else {
          self.output.warn($('No frontend ip configurations found'));
        }
      }
    });
  },

  showFrontendIP: function (ipConfig) {
    var self = this;
    self.interaction.formatOutput(ipConfig, function (ipConfig) {
      lbShowUtil.showFrontendIpConfig(ipConfig, self.output);
    });
  },

  deleteFrontendIP: function (resourceGroupName, lbName, ipConfigName, options, _) {
    var self = this;
    var frontendIpConfResult = self._getFrontendIP(resourceGroupName, lbName, ipConfigName, _);
    var frontendIpConfIndex = frontendIpConfResult.index;

    if (frontendIpConfIndex) {
      throw new Error(util.format($('Frontend IP configuration "%s" nof found in the load balancer "%s"'), ipConfigName, lbName));
    }

    var lb = frontendIpConfResult.loadBalancer;
    if (!options.quiet && !self.interaction.confirm(util.format($('Delete frontend ip configuration "%s"? [y/n] '), ipConfigName), _)) {
      return;
    }

    lb.frontendIpConfigurations.splice(frontendIpConfIndex, 1);
    self.update(resourceGroupName, lbName, lb, _);
  },

  /**
   * Commands to manage Backend Address Pools
   */

  createBackendAddressPool: function (resourceGroupName, lbName, poolName, options, _) {
    var self = this;
    var backendAddressPoolObj = self._getBackendAddressPool(resourceGroupName, lbName, poolName, _);
    var lb = backendAddressPoolObj.loadBalancer;

    var addressPool = backendAddressPoolObj.object;
    if (addressPool) {
      throw new Error(util.format($('A backend address pool with name "%s" already exists in the load balancer "%s"'), poolName, lbName));
    }

    var backendAddressPool = {
      name: poolName,
      properties: {}
    };
    lb.backendAddressPools.push(backendAddressPool);

    self.update(resourceGroupName, lbName, lb, _);
    var newBackendAddressPool = self._getBackendAddressPool(resourceGroupName, lbName, poolName, _).object;
    self.showBackendAddressPool(newBackendAddressPool);
  },

  listBackendAddressPools: function (resourceGroupName, lbName, options, _) {
    var self = this;
    var lb = self.get(resourceGroupName, lbName, _);

    if (!lb) {
      throw new Error(util.format($('A load balancer with name "%s" not found in the resource group "%s"'), lbName, resourceGroupName));
    }

    var pools = lb.loadBalancer.backendAddressPools;
    self.interaction.formatOutput(pools, function (outputData) {
      if (outputData.length !== 0) {
        self.output.table(outputData, function (row, pool) {
          row.cell($('Name'), pool.name);
          row.cell($('Provisioning state'), pool.provisioningState);
        });
      } else {
        if (self.output.format().json) {
          self.output.json([]);
        } else {
          self.output.warn($('No backend address pools found'));
        }
      }
    });
  },

  showBackendAddressPool: function (backendAddressPool) {
    var self = this;
    self.interaction.formatOutput(backendAddressPool, function (backendAddressPool) {
      lbShowUtil.showBackendAddressPool(backendAddressPool, self.output);
    });
  },

  deleteBackendAddressPool: function (resourceGroupName, lbName, poolName, options, _) {
    var self = this;
    var backendAddressPoolObj = self._getBackendAddressPool(resourceGroupName, lbName, poolName, _);
    var lb = backendAddressPoolObj.loadBalancer;

    var backendAddressPoolIndex = backendAddressPoolObj.index;
    if (backendAddressPoolIndex === null || backendAddressPoolIndex === undefined || backendAddressPoolIndex === -1) {
      throw new Error(util.format($('Backend address pool with name "%s" not found in the load balancer "%s"'), poolName, lbName));
    }

    if (!options.quiet && !self.interaction.confirm(util.format($('Delete backend address pool "%s"? [y/n] '), poolName), _)) {
      return;
    }

    lb.backendAddressPools.splice(backendAddressPoolIndex, 1);
    self.update(resourceGroupName, lbName, lb, _);
  },

  /**
   * Commands to manage load balancing Rules
   */

  createRule: function (resourceGroupName, lbName, ruleName, options, _) {
    var self = this;
    var lb = self.get(resourceGroupName, lbName, _);
    if (!lb) {
      throw new Error(util.format($('A load balancer with name "%s" not found in the resource group "%s"'), lbName, resourceGroupName));
    }

    lb = lb.loadBalancer;

    if (!lb.loadBalancingRules) {
      lb.loadBalancingRules = [];
    }

    // check if rule with same name already exists
    var lbRule = utils.findFirstCaseIgnore(lb.loadBalancingRules, {
      name: ruleName
    });
    if (lbRule) {
      throw new Error(util.format($('Rule with the same name already exists in load balancer "%s"'), lbName));
    }

    var rule = {
      name: ruleName
    };
    rule = self._parseRule(lb, rule, options, true);

    lb.loadBalancingRules.push(rule);
    self.update(resourceGroupName, lbName, lb, _);

    var newLb = self.get(resourceGroupName, lbName, _, 'Loading rule state');
    var newRule = utils.findFirstCaseIgnore(newLb.loadBalancer.loadBalancingRules, {
      name: ruleName
    });
    self.showRule(newRule);
  },

  setRule: function (resourceGroupName, lbName, ruleName, options, _) {
    var self = this;
    var lb = self.get(resourceGroupName, lbName, _);
    if (!lb) {
      throw new Error(util.format($('A load balancer with name "%s" not found in the resource group "%s"'), lbName, resourceGroupName));
    }
    lb = lb.loadBalancer;

    // check if rule exists
    var lbRule = utils.findFirstCaseIgnore(lb.loadBalancingRules, {
      name: ruleName
    });
    if (!lbRule) {
      throw new Error(util.format($('Rule with the name "%s" not found in load balancer "%s"'), ruleName, lbName));
    }

    lbRule.name = options.newRuleName || ruleName;
    lbRule = self._parseRule(lb, lbRule, options, false);
    self.update(resourceGroupName, lbName, lb, _);

    var newLb = self.get(resourceGroupName, lbName, _, 'Loading rule state');
    var newRule = utils.findFirstCaseIgnore(newLb.loadBalancer.loadBalancingRules, {
      name: lbRule.name
    });
    self.showRule(newRule);
  },

  listRules: function (resourceGroupName, lbName, options, _) {
    var self = this;
    var lb = self.get(resourceGroupName, lbName, _);

    if (!lb) {
      throw new Error(util.format($('A load balancer with name "%s" not found in the resource group "%s"'), lbName, resourceGroupName));
    }

    var rules = lb.loadBalancer.loadBalancingRules;
    self.interaction.formatOutput(rules, function (outputData) {
      if (outputData.length !== 0) {
        self.output.table(outputData, function (row, rule) {
          row.cell($('Name'), rule.name);
          row.cell($('Provisioning state'), rule.provisioningState);
          row.cell($('Protocol'), rule.protocol);
          row.cell($('Frontend port'), rule.frontendPort);
          row.cell($('Backend port'), rule.backendPort);
          row.cell($('Enable floating IP'), rule.enableFloatingIP);
          row.cell($('Idle timeout in minutes'), rule.idleTimeoutInMinutes);
          row.cell($('Backend address pool'), rule.backendAddressPool ? rule.backendAddressPool.id : '');
          row.cell($('Probe'), rule.probe ? rule.probe.id : '');
        });
      } else {
        if (self.output.format().json) {
          self.output.json([]);
        } else {
          self.output.warn($('No load balancing rules found'));
        }
      }
    });
  },

  showRule: function (rule) {
    var self = this;
    self.interaction.formatOutput(rule, function (rule) {
      lbShowUtil.showLBRule(rule, self.output);
    });
  },

  deleteRule: function (resourceGroupName, lbName, ruleName, options, _) {
    var self = this;
    var lb = self.get(resourceGroupName, lbName, _);
    if (!lb) {
      throw new Error(util.format($('A load balancer with name "%s" not found in the resource group "%s"'), lbName, resourceGroupName));
    }
    lb = lb.loadBalancer;

    // check if rule exists
    var ruleIndex = utils.indexOfCaseIgnore(lb.loadBalancingRules, {
      name: ruleName
    });
    if (ruleIndex === null) {
      throw new Error(util.format($('A load balancing rule with name "%s" not found in the load balancer "%s"'), ruleName, lbName));
    }

    if (!options.quiet && !self.interaction.confirm(util.format($('Delete load balancing rule %s? [y/n] '), ruleName), _)) {
      return;
    }

    lb.loadBalancingRules.splice(ruleIndex, 1);
    self.update(resourceGroupName, lbName, lb, _);
  },

  /**
   * Commands to manage inbound NAT Rules
   */

  createInboundNatRule: function (resourceGroupName, lbName, name, options, _) {
    var self = this;
    var lb = self.get(resourceGroupName, lbName, _);
    if (!lb) {
      throw new Error(util.format($('A load balancer with name "%s" not found in the resource group "%s"'), lbName, resourceGroupName));
    }

    var inboundRule = {
      name: name
    };
    inboundRule = self._parseInboundNatRule(resourceGroupName, lb.loadBalancer, inboundRule, options, true);
    var inboundRules = lb.loadBalancer.inboundNatRules;
    if (!inboundRules) {
      lb.loadBalancer.inboundNatRules = [];
    }

    if (utils.findFirstCaseIgnore(inboundRules, {
        name: name
      })) {
      self.output.error(util.format($('An inbound NAT rule with name "%s" already exist in the load balancer "%s"'), name, lbName));
    }

    lb.loadBalancer.inboundNatRules.push(inboundRule);
    self.update(resourceGroupName, lbName, lb.loadBalancer, _);

    var newLb = self.get(resourceGroupName, lbName, _);
    var newRule = utils.findFirstCaseIgnore(newLb.loadBalancer.inboundNatRules, {
      name: name
    });
    self.showInboundRule(newRule);
  },

  setInboundNatRule: function (resourceGroupName, lbName, name, options, _) {
    var self = this;
    var lb = self.get(resourceGroupName, lbName, _);
    if (!lb) {
      throw new Error(util.format($('A load balancer with name "%s" not found in the resource group "%s"'), lbName, resourceGroupName));
    }

    var allInboundRules = lb.loadBalancer.inboundNatRules;
    var currentInboundRule = utils.findFirstCaseIgnore(allInboundRules, {
      name: name
    });
    if (!currentInboundRule) {
      throw new Error(util.format($('An inbound NAT rule with name "%s" does not exist in the load balancer "%s"'), name, lbName));
    }

    self._parseInboundNatRule(resourceGroupName, lb.loadBalancer, currentInboundRule, options, false);
    self.update(resourceGroupName, lbName, lb.loadBalancer, _);

    var newLb = self.get(resourceGroupName, lbName, _);
    var updatedRule = utils.findFirstCaseIgnore(newLb.loadBalancer.inboundNatRules, {
      name: name
    });
    self.showInboundRule(updatedRule);
  },

  listInboundNatRules: function (resourceGroupName, lbName, options, _) {
    var self = this;
    var lb = self.get(resourceGroupName, lbName, _);

    if (!lb) {
      throw new Error(util.format($('A load balancer with name "%s" not found in the resource group "%s"'), lbName, resourceGroupName));
    }

    var rules = lb.loadBalancer.inboundNatRules;
    self.interaction.formatOutput(rules, function (outputData) {
      if (outputData.length !== 0) {
        self.output.table(outputData, function (row, rule) {
          row.cell($('Name'), rule.name);
          row.cell($('Provisioning state'), rule.provisioningState);
          row.cell($('Protocol'), rule.protocol);
          row.cell($('Frontend port'), rule.frontendPort);
          row.cell($('Backend port'), rule.backendPort);
          row.cell($('Enable floating IP'), rule.enableFloatingIP);
          row.cell($('Idle timeout in minutes'), rule.idleTimeoutInMinutes);
          row.cell($('Backend IP configuration'), rule.backendIPConfiguration ? rule.backendIPConfiguration.id : '');
        });
      } else {
        if (self.output.format().json) {
          self.output.json([]);
        } else {
          self.output.warn($('No inbound NAT rules found'));
        }
      }
    });
  },

  showInboundRule: function (rule) {
    var self = this;
    self.interaction.formatOutput(rule, function (rule) {
      lbShowUtil.showInboundRule(rule, self.output);
    });
  },

  deleteInboundNatRule: function (resourceGroupName, lbName, name, options, _) {
    var self = this;
    var lb = self.get(resourceGroupName, lbName, _);
    if (!lb) {
      throw new Error(util.format($('A load balancer with name "%s" not found in the resource group "%s"'), lbName, resourceGroupName));
    }

    var inboundRules = lb.loadBalancer.inboundNatRules;
    if (!inboundRules) {
      throw new Error(util.format($('A load balancer with name "%s" does not contain any inbound NAT rules'), lbName));
    }

    var index = utils.indexOfCaseIgnore(inboundRules, {
      name: name
    });
    if (index !== null) {
      if (!options.quiet && !self.interaction.confirm(util.format($('Delete inbound NAT rule "%s?" [y/n] '), name), _)) {
        return;
      }
      lb.loadBalancer.inboundNatRules.splice(index, 1);
      self.update(resourceGroupName, lbName, lb.loadBalancer, _);
    } else {
      self.output.error(util.format($('An inbound NAT rule with name "%s" does not exist in the load balancer "%s"'), name, lbName));
    }
  },

  _parseProbe: function (probeName, params, useDefaults) {
    var self = this;

    var probeProfile = {
      name: probeName
    };

    if (params.path) {
      if (utils.stringIsNullOrEmpty(params.path)) {
        throw new Error($('Path parameter must not be null or empty string'));
      }
      probeProfile.requestPath = params.path;
    }

    if (params.protocol) {
      var protocolValidation = self.endpointUtil.validateProbProtocol(params.protocol, 'Protocol');
      if (protocolValidation.error) {
        throw new Error(protocolValidation.error);
      }

      var protocol = protocolValidation.protocol.toLowerCase();
      if (protocol === self.endpointUtil.protocols.TCP && params.path) {
        self.output.warn($('Probe request path will be ignored when its protocol is Tcp'));
        delete probeProfile.requestPath;
      }

      if (protocol === self.endpointUtil.protocols.HTTP && !params.path) {
        throw new Error($('Probe request path is required when its protocol is Http'));
      }

      probeProfile.protocol = protocolValidation.protocol;
    } else if (useDefaults) {
      self.output.warn(util.format($('Using default probe protocol: %s'), constants.LB_DEFAULT_PROBE_PROTOCOL));
      probeProfile.protocol = constants.LB_DEFAULT_PROBE_PROTOCOL;
    }

    if (params.port) {
      var portValidation = self.endpointUtil.validatePort(params.port, 'Port');
      if (portValidation.error) throw new Error(portValidation.error);
      probeProfile.port = portValidation.port;
    } else if (useDefaults) {
      self.output.warn(util.format($('Using default probe port: %s'), constants.LB_DEFAULT_PROBE_PORT));
      probeProfile.port = constants.LB_DEFAULT_PROBE_PORT;
    }

    if (params.interval) {
      var intervalValidation = self.endpointUtil.validateProbInterval(params.interval, 'Interval');
      if (intervalValidation.error) throw new Error(intervalValidation.error);
      probeProfile.intervalInSeconds = intervalValidation.interval;
    }

    if (params.count) {
      var countAsInt = utils.parseInt(params.count);
      if (isNaN(countAsInt)) {
        throw new Error(util.format($('Count parameter must be an integer'), countAsInt));
      }
      probeProfile.numberOfProbes = countAsInt;
    }

    if (params.newProbeName) {
      if (utils.stringIsNullOrEmpty(params.newProbeName)) {
        throw new Error($('Name parameter must not be null or empty string'));
      }
      probeProfile.name = params.newProbeName;
    }

    return probeProfile;
  },

  _parseRule: function (lb, rule, options, useDefaults) {
    var self = this;

    if (options.protocol) {
      var protocolValidation = self.endpointUtil.validateProtocol(options.protocol, 'protocol');
      if (protocolValidation.error) {
        throw new Error(protocolValidation.error);
      }

      rule.protocol = options.protocol;
    } else if (useDefaults) {
      options.protocol = constants.LB_DEFAULT_PROTOCOL;
      self.output.verbose(util.format($('Using default protocol: %s'), options.protocol));
      rule.protocol = options.protocol;
    }

    if (options.frontendPort) {
      var frontendPortValidation = self.endpointUtil.validatePort(options.frontendPort, 'front end port');
      if (frontendPortValidation.error) {
        throw new Error(frontendPortValidation.error);
      }

      rule.frontendPort = options.frontendPort;
    } else if (useDefaults) {
      options.frontendPort = constants.LB_DEFAULT_FRONTEND_PORT;
      self.output.verbose(util.format($('Using default frontend port: %s'), options.frontendPort));
      rule.frontendPort = options.frontendPort;
    }

    if (options.backendPort) {
      var backendPortValidation = self.endpointUtil.validatePort(options.backendPort, 'back end port');
      if (backendPortValidation.error) {
        throw new Error(backendPortValidation.error);
      }

      rule.backendPort = options.backendPort;
    } else if (useDefaults) {
      options.backendPort = constants.LB_DEFAULT_BACKEND_PORT;
      self.output.verbose(util.format($('Using default backend port: %s'), options.backendPort));
      rule.backendPort = options.backendPort;
    }

    if (options.idleTimeout) {
      var parsed = utils.parseInt(options.idleTimeout);
      if (isNaN(parsed)) {
        throw new Error($('Idle timeout must be posivite integer'));
      }

      rule.idleTimeoutInMinutes = options.idleTimeout;
    } else if (useDefaults) {
      options.idleTimeout = constants.LB_DEFAULT_IDLE_TIMEOUT;
      self.output.verbose(util.format($('Using default idle timeout: %s'), options.idleTimeout));
      rule.idleTimeoutInMinutes = options.idleTimeout;
    }

    if (options.enableFloatingIp) {

      // Enable floating IP must be boolean.
      if (!utils.ignoreCaseEquals(options.enableFloatingIp, 'true') && !utils.ignoreCaseEquals(options.enableFloatingIp, 'false')) {
        throw new Error($('Enable floating IP parameter must be boolean'));
      }

      rule.enableFloatingIP = options.enableFloatingIp;
    } else if (useDefaults) {
      options.enableFloatingIp = constants.LB_DEFAULT_FLOATING_IP;
      self.output.verbose(util.format($('Using default enable floating ip: %s'), options.enableFloatingIp));
      rule.enableFloatingIP = options.enableFloatingIp;
    }

    var backendAddressPool = null;
    if (options.backendAddressPool) {
      backendAddressPool = utils.findFirstCaseIgnore(lb.backendAddressPools, {
        name: options.backendAddressPool
      });
      if (!backendAddressPool) {
        throw new Error(util.format($('Backend address pool "%s" not found'), options.backendAddressPool));
      }

      rule.backendAddressPool = {
        id: backendAddressPool.id
      };
    } else if (useDefaults) {
      if (!lb.backendAddressPools || lb.backendAddressPools.length === 0) {
        throw new Error($('Load balancer must have at least one backend address pool if --backend-address-pool parameter is not specified.'));
      }

      self.output.verbose(util.format($('Using first backend address pool: %s'), lb.backendAddressPools[0].name));
      backendAddressPool = lb.backendAddressPools[0];
      rule.backendAddressPool = {
        id: backendAddressPool.id
      };
    }

    if (options.frontendIpName) {
      rule.frontendIPConfiguration = {};
      ipConfigFound = utils.findFirstCaseIgnore(lb.frontendIpConfigurations, {
        name: options.frontendIpName
      });
      if (!ipConfigFound) {
        throw new Error(util.format($('Frontend IP config "%s" not found'), options.frontendIpName));
      }

      rule.frontendIPConfiguration.id = ipConfigFound.id;
    } else if (useDefaults) {
      rule.frontendIPConfiguration = {};
      if (!lb.frontendIpConfigurations || lb.frontendIpConfigurations.length === 0) {
        throw new Error($('Load balancer must have at least one frontend IP configuration if --frontend-ip-name parameter is not specified.'));
      }

      self.output.verbose(util.format($('Using first frontend IP config: %s'), lb.frontendIpConfigurations[0].name));
      defaultIpConfig = lb.frontendIpConfigurations[0];
      rule.frontendIPConfiguration.id = defaultIpConfig.id;
    }

    var optionalProbe = utils.getOptionalArg(options.probeName);
    if (optionalProbe.hasValue) {
      if (optionalProbe.value !== null) {
        // probes must exist
        if (!lb.probes || lb.probes.length === 0) {
          throw new Error(util.format($('No probes found for the load balancer "%s"'), lb.name));
        }

        // probe with provided name must exist
        var probe = utils.findFirstCaseIgnore(lb.probes, {
          name: options.probeName
        });
        if (!probe) {
          throw new Error(util.format($('Probe "%s" not found in the load balancer "%s"'), options.probeName, lb.name));
        }

        rule.probe = {
          id: probe.id
        };
      } else {
        self.output.verbose($('Clearing probe'));
        if (rule.probe) {
          delete rule.probe;
        }
      }
    }

    return rule;
  },

  _parseInboundNatRule: function (resourceGroupName, lb, inboundRule, options, useDefaults) {
    var self = this;

    if (options.protocol) {
      var protocolValidation = self.endpointUtil.validateProtocol(options.protocol, 'protocol');
      if (protocolValidation.error) {
        throw new Error(protocolValidation.error);
      }
      inboundRule.protocol = options.protocol;
    } else if (useDefaults) {
      options.protocol = constants.LB_DEFAULT_PROTOCOL;
      self.output.verbose(util.format($('Using default protocol: %s'), options.protocol));
      inboundRule.protocol = options.protocol;
    }

    if (options.frontendPort) {
      var frontendPortValidation = self.endpointUtil.validatePort(options.frontendPort, 'front end port');
      if (frontendPortValidation.error) {
        throw new Error(frontendPortValidation.error);
      }
      inboundRule.frontendPort = options.frontendPort;
    } else if (useDefaults) {
      options.frontendPort = constants.LB_DEFAULT_FRONTEND_PORT;
      self.output.verbose(util.format($('Using default frontend port: %s'), options.frontendPort));
      inboundRule.frontendPort = options.frontendPort;
    }

    if (options.backendPort) {
      var backendPortValidation = self.endpointUtil.validatePort(options.backendPort, 'back end port');
      if (backendPortValidation.error) {
        throw new Error(backendPortValidation.error);
      }
      inboundRule.backendPort = options.backendPort;
    } else if (useDefaults) {
      options.backendPort = constants.LB_DEFAULT_BACKEND_PORT;
      self.output.verbose(util.format($('Using default backend port: %s'), options.backendPort));
      inboundRule.backendPort = options.backendPort;
    }

    if (options.enableFloatingIp) {

      // Enable floating IP must be boolean.
      if (!utils.ignoreCaseEquals(options.enableFloatingIp, 'true') && !utils.ignoreCaseEquals(options.enableFloatingIp, 'false')) {
        throw new Error($('Enable floating IP parameter must be boolean'));
      }

      inboundRule.enableFloatingIP = options.enableFloatingIp;
    } else if (useDefaults) {
      options.enableFloatingIp = constants.LB_DEFAULT_FLOATING_IP;
      self.output.verbose(util.format($('Using default enable floating ip: %s'), options.enableFloatingIp));
      inboundRule.enableFloatingIP = options.enableFloatingIp;
    }

    if (options.frontendIp) {
      var ipConfigurations = options.frontendIp.split(',');
      for (var num in ipConfigurations) {
        var frontendIpConf = ipConfigurations[num];
        var frontendIpConfFound = utils.findFirstCaseIgnore(lb.frontendIpConfigurations, {
          name: frontendIpConf
        });
        if (!frontendIpConfFound) {
          throw new Error(util.format($('Frontend IP config "%s" not found'), frontendIpConf));
        }
        inboundRule.frontendIPConfiguration = {
          id: frontendIpConfFound.id
        };
      }
    } else if (useDefaults) {
      if (!inboundRule.frontendIPConfiguration) {
        if (lb.frontendIpConfigurations.length === 0) {
          throw new Error(util.format($('Load balancer with name "%s" has no frontend IP configurations'), lb.name));
        }
        inboundRule.frontendIPConfiguration = {
          id: lb.frontendIpConfigurations[0].id
        };
        self.output.verbose($('Setting default inbound rule frontend IP configuration'));
      }
    }

    return inboundRule;
  },

  _parseFrontendIP: function (resourceGroupName, frontendIPConfig, options, _) {
    var self = this;
    if (options.privateIpAddress && options.publicIpName) {
      throw new Error($('Both optional parameters --private-ip-address and --public-ip-name cannot be specified together'));
    }

    if (options.privateIpAddress && options.publicIpId) {
      throw new Error($('Both optional parameters --private-ip-address and --public-ip-id cannot be specified together'));
    }

    if (options.publicIpName && options.publicIpId) {
      throw new Error($('Both optional parameters --public-ip-name and --public-ip-id cannot be specified together'));
    }

    if (options.subnetName && options.subnetId) {
      throw new Error($('Both optional parameters --subnet-name and --subnet-id cannot be specified together'));
    }

    if (!options.subnetId) {
      if (options.subnetName) {
        if (!options.vnetName) {
          throw new Error($('You must specify subnet virtual network (vnet-name) if subnet name (subnet-name)  is provided'));
        }
      }

      if (options.vnetName) {
        if (!options.subnetName) {
          throw new Error($('You must specify  subnet name (subnet-name) if subnet virtual network (vnet-name) is provided'));
        }
      }
    }

    var subnetIdOpt = null;
    var publicIpIdOpt = null;
    var hasPublicIP = false;

    if (options.subnetName || options.subnetId) {
      frontendIPConfig.subnet = {};
      if (options.subnetId) {
        subnetIdOpt = utils.getOptionalArg(options.subnetId);
        if (subnetIdOpt.value) {
          frontendIPConfig.subnet.id = subnetIdOpt.value.replace(/'|""/gm, '');
        } else {
          delete frontendIPConfig.subnet;
        }
      } else {
        var subnet = self.subnetCrud.get(resourceGroupName, options.vnetName, options.subnetName, _);
        if (!subnet) {
          throw new Error(util.format($('Subnet with name "%s" not found'), options.subnetName));
        }
        frontendIPConfig.subnet.id = subnet.id;
      }
    }

    if (options.publicIpName || options.publicIpId) {
      frontendIPConfig.publicIpAddress = {};
      if (options.publicIpId) {
        publicIpIdOpt = utils.getOptionalArg(options.publicIpId);
        if (publicIpIdOpt.value) {
          frontendIPConfig.publicIpAddress.id = publicIpIdOpt.value.replace(/'|""/gm, '');
          hasPublicIP = true;
        } else {
          delete frontendIPConfig.publicIpAddress;
        }
      } else {
        var publicip = self.publicIpCrud.get(resourceGroupName, options.publicIpName, _);
        if (!publicip) {
          throw new Error(util.format($('Public IP "%s" not found'), options.publicIpName));
        }

        frontendIPConfig.publicIpAddress.id = publicip.id;
        hasPublicIP = true;
      }
    }

    var privateIpAddressOpt = utils.getOptionalArg(options.privateIpAddress);
    if (hasPublicIP) {
      delete frontendIPConfig.privateIpAddress;
      delete frontendIPConfig.privateIpAllocationMethod;
    }

    if (privateIpAddressOpt.hasValue) {
      if (privateIpAddressOpt.value) {
        frontendIPConfig.privateIpAddress = privateIpAddressOpt.value;
        frontendIPConfig.privateIpAllocationMethod = 'Static';
      } else {
        delete frontendIPConfig.privateIpAddress;
        frontendIPConfig.privateIpAllocationMethod = 'Dynamic';
      }
    }

    return frontendIPConfig;
  },

  _getFrontendIP: function (resourceGroupName, lbName, ipConfigName, _) {
    var self = this;
    var lb = self.get(resourceGroupName, lbName, _);
    if (!lb) {
      throw new Error(util.format($('A load balancer with name "%s" not found in the resource group "%s"'), lbName, resourceGroupName));
    }

    lb = lb.loadBalancer;

    var frontendIpConf = utils.findFirstCaseIgnore(lb.frontendIpConfigurations, {
      name: ipConfigName
    });
    var frontendIpConfIndex = utils.indexOfCaseIgnore(lb.frontendIpConfigurations, {
      name: ipConfigName
    });

    return {
      object: frontendIpConf,
      index: frontendIpConfIndex,
      loadBalancer: lb
    };
  },

  _getBackendAddressPool: function (resourceGroupName, lbName, poolName, _) {
    var self = this;
    var lb = self.get(resourceGroupName, lbName, _);
    if (!lb) {
      throw new Error(util.format($('A load balancer with name "%s" not found in the resource group "%s"'), lbName, resourceGroupName));
    }

    lb = lb.loadBalancer;

    var addressPool = utils.findFirstCaseIgnore(lb.backendAddressPools, {
      name: poolName
    });
    var addressPoolIndex = utils.indexOfCaseIgnore(lb.backendAddressPools, {
      name: poolName
    });

    return {
      object: addressPool,
      index: addressPoolIndex,
      loadBalancer: lb
    };
  }
});

module.exports = LoadBalancer;
