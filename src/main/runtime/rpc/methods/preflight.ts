import { defineMethod } from '../core'
import {
  detectRemoteAgents,
  detectRemoteWindowsTerminalCapabilities,
  detectInstalledAgentsWithShellPathHydration,
  refreshShellPathAndDetectAgents,
  runPreflightCheck,
  type PreflightRuntimeContext
} from '../../../preflight/agent-detection'
import {
  PreflightCheck,
  PreflightDetectAgents,
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
    params: PreflightDetectAgents,
    handler: async (params) =>
      detectInstalledAgentsWithShellPathHydration(toPreflightRuntimeContext(params))
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
    params: PreflightDetectAgents,
    handler: async (params) => refreshShellPathAndDetectAgents(toPreflightRuntimeContext(params))
  })
]

// Why undefined rather than an empty object: no target named means host-local, and
// `getPreflightWslTarget` distinguishes "no context" from "context that selected nothing".
function toPreflightRuntimeContext(params: {
  wslDistro?: string | undefined
  wslDefault?: boolean | undefined
}): PreflightRuntimeContext | undefined {
  if (!params.wslDistro && !params.wslDefault) {
    return undefined
  }
  return {
    ...(params.wslDistro ? { wslDistro: params.wslDistro } : {}),
    ...(params.wslDefault ? { wslDefault: true } : {})
  }
}
