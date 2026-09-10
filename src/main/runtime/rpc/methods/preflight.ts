import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
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

const PreflightCheck = z.object({
  force: z.boolean().optional()
})
const PreflightDetectRemoteAgents = z.object({
  connectionId: z.string().min(1)
})
const PreflightDetectRemoteWindowsTerminalCapabilities = z.object({
  connectionId: z.string().min(1)
})
const PreflightUpdateAgent = z.object({
  provider: z.enum(['claude', 'codex'])
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
    name: 'preflight.probeAgentHealth',
    params: null,
    handler: async () => probeAgentHealth()
  }),
  defineMethod({
    name: 'preflight.probeAgentHealthProvider',
    params: PreflightUpdateAgent,
    handler: async (params) => probeAgentProviderHealth(params.provider)
  }),
  defineMethod({
    name: 'preflight.updateAgent',
    params: PreflightUpdateAgent,
    handler: async (params) => updateAgent(params.provider)
  })
]
