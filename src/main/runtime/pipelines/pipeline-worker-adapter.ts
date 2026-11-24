import type { OrcaRuntimeService } from '../orca-runtime'
import type { PipelinePorts } from './pipeline-controller'
import { startLocalWorker } from '../rpc/methods/orchestration/worker/start/local-worker-start'
import {
  decideWorkerStartMode,
  readWorkerStartModeSettings
} from '../rpc/methods/orchestration/structured-workers/orchestration-worker-start-mode'

export function pipelineWorkerPorts(
  runtime: OrcaRuntimeService
): Pick<PipelinePorts, 'start' | 'settled'> {
  const db = runtime.getOrchestrationDb()
  return {
    settled: async (dispatchId) =>
      ['completed', 'failed', 'circuit_broken'].includes(
        db.getDispatchContextById(dispatchId)?.status ?? ''
      ),
    start: async (run, spec, prepared) => {
      const role = run.stage === 'review' ? run.profile.roles.reviewer : run.profile.roles.primary
      const params = {
        from: '',
        spec,
        worktree: `id:${run.workspace.id}`,
        ...(run.stage !== 'review' && run.primarySessionId
          ? { terminal: run.primarySessionId }
          : { agent: role.agent, model: role.model, effort: role.effort })
      }
      const orchestrationRun = db.createRun({
        objective: `Pipeline ${run.id}: ${run.stage}`,
        coordinatorHandle: null,
        coordinatorPaneKey: null
      })
      let worker: { dispatchId: string; sessionId: string } | undefined
      const result = await startLocalWorker({
        runtime,
        db,
        params,
        coordinator: null,
        bindRun: () => orchestrationRun,
        taskDeps: undefined,
        mode: decideWorkerStartMode({ params, settings: readWorkerStartModeSettings(runtime) }),
        systemCoordinator: {
          workspaceId: run.workspace.id,
          prepared: (value) => {
            worker = value
            prepared(value)
          }
        }
      })
      const state =
        result &&
        typeof result === 'object' &&
        'state' in result &&
        typeof result.state === 'string'
          ? result.state
          : 'outcome_unknown'
      return { state, dispatchId: worker?.dispatchId ?? '', sessionId: worker?.sessionId ?? '' }
    }
  }
}
