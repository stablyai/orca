import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import {
  detectRemoteAgents,
  detectRemoteAgentCommands,
  detectRemoteAgentInventory,
  detectRemoteWindowsTerminalCapabilities,
  detectInstalledAgentsWithShellPathHydration,
  detectInstalledAgentCommandsWithShellPathHydration,
  detectInstalledAgentInventoryWithShellPathHydration,
  refreshShellPathAndDetectAgents,
  runPreflightCheck
} from '../../../ipc/preflight'

const PreflightCheck = z.object({
  force: z.boolean().optional()
})
const PreflightLocalAgentContext = z.object({
  wslDistro: z.string().min(1).optional()
})
const PreflightDetectRemoteAgents = z.object({
  connectionId: z.string().min(1)
})
const PreflightDetectRemoteWindowsTerminalCapabilities = z.object({
  connectionId: z.string().min(1)
})

export const PREFLIGHT_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'preflight.check',
    params: PreflightCheck,
    handler: async (params) => runPreflightCheck(params.force)
  }),
  defineMethod({
    name: 'preflight.detectAgents',
    params: PreflightLocalAgentContext,
    handler: async (params) => detectInstalledAgentsWithShellPathHydration(params)
  }),
  defineMethod({
    name: 'preflight.detectAgentCommands',
    params: PreflightLocalAgentContext,
    handler: async (params) => detectInstalledAgentCommandsWithShellPathHydration(params)
  }),
  defineMethod({
    name: 'preflight.detectAgentInventory',
    params: PreflightLocalAgentContext,
    handler: async (params) => detectInstalledAgentInventoryWithShellPathHydration(params)
  }),
  defineMethod({
    name: 'preflight.detectRemoteAgents',
    params: PreflightDetectRemoteAgents,
    handler: async (params) => detectRemoteAgents(params)
  }),
  defineMethod({
    name: 'preflight.detectRemoteAgentCommands',
    params: PreflightDetectRemoteAgents,
    handler: async (params) => detectRemoteAgentCommands(params)
  }),
  defineMethod({
    name: 'preflight.detectRemoteAgentInventory',
    params: PreflightDetectRemoteAgents,
    handler: async (params) => detectRemoteAgentInventory(params)
  }),
  defineMethod({
    name: 'preflight.detectRemoteWindowsTerminalCapabilities',
    params: PreflightDetectRemoteWindowsTerminalCapabilities,
    handler: async (params) => detectRemoteWindowsTerminalCapabilities(params)
  }),
  defineMethod({
    name: 'preflight.refreshAgents',
    params: PreflightLocalAgentContext,
    handler: async (params) => refreshShellPathAndDetectAgents(params)
  })
]
