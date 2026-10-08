import { defineMethod } from '../core'
import {
  detectRemoteAgents,
  detectRemoteWindowsTerminalCapabilities,
  detectInstalledAgentsWithShellPathHydration,
  refreshShellPathAndDetectAgents,
  runPreflightCheck
} from '../../../preflight/agent-detection'
import {
  PreflightCheck,
  PreflightDetectRemoteAgents,
  PreflightDetectRemoteWindowsTerminalCapabilities
} from '../../../../shared/rpc-contract/preflight-params'

export const PREFLIGHT_METHODS = [
  defineMethod({
    name: 'preflight.check',
    permission: 'workspace',
    params: PreflightCheck,
    handler: async (params) => runPreflightCheck(params.force)
  }),
  defineMethod({
    name: 'preflight.detectAgents',
    permission: 'workspace',
    params: null,
    handler: async () => detectInstalledAgentsWithShellPathHydration()
  }),
  defineMethod({
    name: 'preflight.detectRemoteAgents',
    permission: 'workspace',
    params: PreflightDetectRemoteAgents,
    handler: async (params) => {
      const agents = await detectRemoteAgents(params)
      if (agents === null) {
        // Why: older clients expect string[]; an error keeps them on their existing failure path.
        throw new Error(`SSH connection ${params.connectionId} is not connected`)
      }
      return agents
    }
  }),
  defineMethod({
    name: 'preflight.detectRemoteWindowsTerminalCapabilities',
    permission: 'workspace',
    params: PreflightDetectRemoteWindowsTerminalCapabilities,
    handler: async (params) => detectRemoteWindowsTerminalCapabilities(params)
  }),
  defineMethod({
    name: 'preflight.refreshAgents',
    permission: 'workspace',
    params: null,
    handler: async () => refreshShellPathAndDetectAgents()
  })
]
