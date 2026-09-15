import { defineMethod } from '../core'
import {
  detectRemoteAgents,
  detectRemoteWindowsTerminalCapabilities,
  detectInstalledAgentsWithShellPathHydration,
  refreshShellPathAndDetectAgents,
  runPreflightCheck
} from '../../../preflight/agent-detection'
import {
  probeAgentHealth,
  probeAgentProviderHealth,
  updateAgent
} from '../../../ipc/agent-health-probe'
import {
  PreflightAgentHealthProvider,
  PreflightCheck,
  PreflightDetectRemoteAgents,
  PreflightDetectRemoteWindowsTerminalCapabilities
} from '../../../../shared/rpc-contract/preflight-params'

export const PREFLIGHT_METHODS = [
  defineMethod({
    name: 'preflight.check',
    params: PreflightCheck,
    handler: async (params) => runPreflightCheck(params.force)
  }),
  defineMethod({
    name: 'preflight.detectAgents',
    params: null,
    handler: async () => detectInstalledAgentsWithShellPathHydration()
  }),
  defineMethod({
    name: 'preflight.detectRemoteAgents',
    params: PreflightDetectRemoteAgents,
    handler: async (params) => detectRemoteAgents(params)
  }),
  defineMethod({
    name: 'preflight.detectRemoteWindowsTerminalCapabilities',
    params: PreflightDetectRemoteWindowsTerminalCapabilities,
    handler: async (params) => detectRemoteWindowsTerminalCapabilities(params)
  }),
  defineMethod({
    name: 'preflight.refreshAgents',
    params: null,
    handler: async () => refreshShellPathAndDetectAgents()
  }),
  defineMethod({
    name: 'preflight.probeAgentHealth',
    params: null,
    handler: async () => probeAgentHealth()
  }),
  defineMethod({
    name: 'preflight.probeAgentHealthProvider',
    params: PreflightAgentHealthProvider,
    handler: async (params) => probeAgentProviderHealth(params.provider)
  }),
  defineMethod({
    name: 'preflight.updateAgent',
    params: PreflightAgentHealthProvider,
    handler: async (params) => updateAgent(params.provider)
  })
]
