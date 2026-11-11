import { defineMethod } from '../../core'
import { AgentMcpSyncParams } from '../../../../../shared/agent-mcp-sync/mcp-sync-contract'
import { getAppEnvironment } from '../../../../../shared/app-environment'
import {
  AgentConfigSyncPlanParams,
  AgentConfigSyncPutParams
} from '../../../../../shared/agent-config-sync/agent-config-sync-contract'
import {
  planHostAgentConfigSync,
  putHostAgentConfig,
  type HostAgentConfigSyncDeps
} from '../../../../agent-config-sync/host/host-agent-config-sync'
import { defaultAgentConfigHomes } from '../../../../agent-config-sync/agent-config-roots'
import {
  defaultHostMcpSyncPaths,
  syncHostMcpServers
} from '../../../../agent-mcp-sync/host/host-mcp-sync'

function hostAgentConfigDeps(): HostAgentConfigSyncDeps {
  return {
    homes: defaultAgentConfigHomes(),
    projectPath: process.env.ORCA_WORKSPACE_PATH?.trim() || null,
    ledgerDir: getAppEnvironment().getPath('userData')
  }
}

const DESKTOP_ONLY = 'Only an Orca desktop can sync its skills and commands to this host.'

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
        paths: defaultHostMcpSyncPaths(getAppEnvironment().getPath('userData')),
        projectPath: process.env.ORCA_WORKSPACE_PATH?.trim() || null
      })
    }
  }),
  // The owning desktop mirrors its own skills and slash commands into this host's agent configs:
  // plan first (no bytes), then put only what the host lacks.
  defineMethod({
    name: 'agentConfig.planSkillSync',
    permission: 'accounts-admin',
    params: AgentConfigSyncPlanParams,
    handler: async (params, { clientKind }) => {
      if (clientKind === 'mobile') {
        throw new Error(DESKTOP_ONLY)
      }
      return planHostAgentConfigSync(params, hostAgentConfigDeps())
    }
  }),
  defineMethod({
    name: 'agentConfig.putSkills',
    permission: 'accounts-admin',
    params: AgentConfigSyncPutParams,
    handler: async (params, { clientKind }) => {
      if (clientKind === 'mobile') {
        throw new Error(DESKTOP_ONLY)
      }
      return putHostAgentConfig(params, hostAgentConfigDeps())
    }
  })
]
