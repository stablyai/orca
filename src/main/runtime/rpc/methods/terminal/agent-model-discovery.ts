import { defineMethod } from '../../core'
import { AgentDiscoverTerminalModels } from '../../../../../shared/rpc-contract/agent-model-discovery-params'
import { hostQualifiedRepoSelector } from '../../../workspaces/catalog/runtime-repo-selector'
import { isTuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent-config'
import {
  decideWorkerStartMode,
  readWorkerStartModeSettings,
  resolveWorkerStartModeOnHost
} from '../orchestration/structured-workers/orchestration-worker-start-mode'
export const AGENT_MODEL_DISCOVERY_METHODS = [
  defineMethod({
    name: 'agent.discoverTerminalModels',
    permission: 'workspace',
    params: AgentDiscoverTerminalModels,
    handler: async (params, { runtime }) => {
      let workerStartMode: 'terminal' | 'structured' | undefined
      if (params.workerStart) {
        // The ordinary destination start has no --on; its own settings and host decide its mode.
        if (!params.repo && (!params.worktree || /^(current|new-child)$/.test(params.worktree))) {
          return { success: false as const, error: 'selector_not_found' }
        }
        const target = params.repo
          ? undefined
          : await runtime.resolveTerminalWorkspaceReadTarget(params.worktree!)
        const mode = await resolveWorkerStartModeOnHost(
          runtime,
          decideWorkerStartMode({
            params: { agent: params.agentId },
            settings: readWorkerStartModeSettings(runtime)
          }),
          target?.scope.id,
          isTuiAgent(params.agentId) ? params.agentId : undefined
        )
        workerStartMode = mode.mode
        if (workerStartMode === 'structured') {
          return {
            success: false as const,
            error: 'terminal_models_not_applicable',
            workerStartMode
          }
        }
      }
      const result = await runtime.discoverTerminalModels(params.worktree, params.agentId, {
        ...(params.repo ? { repo: hostQualifiedRepoSelector(params.repo, params.repoHostId) } : {}),
        folder: params.folder,
        cwd: params.cwd,
        uncached: params.uncached
      })
      return { ...result, ...(workerStartMode ? { workerStartMode } : {}) }
    }
  })
]
