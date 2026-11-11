import { assertAntigravityTerminalEffort } from './antigravity-terminal-effort'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { WorkerStartInput } from '../../rpc/methods/orchestration/worker/worker-start-schema'
import type { DiscoverCommitMessageModelsResult } from '../../../text-generation/source-control-text-generation-types'
import {
  runtimeRepoSelectorText,
  runtimeRepoSelectorHostId
} from '../../workspaces/catalog/runtime-repo-selector'

export async function assertRemoteAntigravityEffort(
  runtime: OrcaRuntimeService,
  params: WorkerStartInput,
  server: ReturnType<OrcaRuntimeService['resolveOrchestrationWorkerServer']>,
  timeoutMs: number,
  ordinaryWorker = false
): Promise<void> {
  if (ordinaryWorker && (!params.worktree || /^(current|new-child)$/.test(params.worktree))) {
    return
  }
  await assertAntigravityTerminalEffort(
    {
      discoverTerminalModels: async (worktree, agentId, options) => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This paired RPC implements the same discovery result contract; unavailable methods reject and pass through admission.
        const result = (await runtime.callOrchestrationWorkerServer(
          server.environmentId,
          'agent.discoverTerminalModels',
          {
            agentId,
            ...(ordinaryWorker ? { workerStart: true } : {}),
            ...(worktree ? { worktree } : {}),
            ...(options?.repo
              ? {
                  repo: runtimeRepoSelectorText(options.repo),
                  repoHostId: runtimeRepoSelectorHostId(options.repo)
                }
              : {}),
            uncached: true
          },
          timeoutMs,
          undefined,
          { expectedEnvironmentPairingRevision: server.pairingRevision }
        )) as DiscoverCommitMessageModelsResult & {
          workerStartMode?: 'terminal' | 'structured'
        }
        return ordinaryWorker && result.workerStartMode !== 'terminal'
          ? { success: false, error: 'terminal_models_not_applicable' }
          : result
      }
    },
    {
      agent: params.agent,
      model: params.model,
      effort: params.effort,
      ...(params.worktree === 'new-child' || params.worktree === 'new-top-level'
        ? { repo: params.repo }
        : { worktree: params.worktree })
    }
  )
}
