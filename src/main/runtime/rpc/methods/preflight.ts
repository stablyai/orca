import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import {
  detectRemoteAgents,
  detectRemoteWindowsTerminalCapabilities,
  detectInstalledAgentsWithShellPathHydration,
  refreshShellPathAndDetectAgents,
  runPreflightCheck
} from '../../../ipc/preflight'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { markRuntimeAgentWorkspaceTrusted } from '../../runtime-agent-trust'

const PreflightCheck = z.object({
  force: z.boolean().optional()
})
const PreflightDetectRemoteAgents = z.object({
  connectionId: z.string().min(1)
})
const PreflightDetectRemoteWindowsTerminalCapabilities = z.object({
  connectionId: z.string().min(1)
})
const PreflightMarkAgentTrusted = z.object({
  agent: z.string().refine(isTuiAgent),
  workspacePath: z.string().min(1)
})

export const PREFLIGHT_METHODS: RpcMethod[] = [
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
    name: 'preflight.markAgentTrusted',
    params: PreflightMarkAgentTrusted,
    handler: async (params) => markRuntimeAgentWorkspaceTrusted(params.agent, params.workspacePath)
  })
]
