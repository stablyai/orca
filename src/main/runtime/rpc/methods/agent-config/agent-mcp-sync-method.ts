import { defineMethod } from '../../core'
import { AgentMcpSyncParams } from '../../../../../shared/agent-mcp-sync/mcp-sync-contract'
import { getAppEnvironment } from '../../../../../shared/app-environment'
import {
  defaultHostMcpSyncPaths,
  syncHostMcpServers
} from '../../../../agent-mcp-sync/host/host-mcp-sync'

export const AGENT_CONFIG_METHODS = [
  // The owning desktop mirrors its own MCP servers into this host's agent configs.
  defineMethod({
    name: 'agentConfig.syncMcpServers',
    permission: 'accounts-admin',
    params: AgentMcpSyncParams,
    handler: async (params, { clientKind }) => {
      if (clientKind === 'mobile') {
        throw new Error('Only an Orca desktop can sync its MCP servers to this host.')
      }
      return syncHostMcpServers(params, {
        paths: defaultHostMcpSyncPaths(getAppEnvironment().getPath('userData'))
      })
    }
  })
]
