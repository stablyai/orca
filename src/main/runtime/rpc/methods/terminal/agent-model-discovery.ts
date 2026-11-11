import { defineMethod } from '../../core'
import { AgentDiscoverTerminalModels } from '../../../../../shared/rpc-contract/agent-model-discovery-params'
import { hostQualifiedRepoSelector } from '../../../workspaces/catalog/runtime-repo-selector'
export const AGENT_MODEL_DISCOVERY_METHODS = [
  defineMethod({
    name: 'agent.discoverTerminalModels',
    permission: 'workspace',
    params: AgentDiscoverTerminalModels,
    handler: (params, { runtime }) =>
      runtime.discoverTerminalModels(params.worktree, params.agentId, {
        ...(params.repo ? { repo: hostQualifiedRepoSelector(params.repo, params.repoHostId) } : {}),
        folder: params.folder,
        cwd: params.cwd,
        uncached: params.uncached
      })
  })
]
