import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { startFederatedWorker } from './orchestration-federated-worker-start'
import { startLocalWorker } from './orchestration-local-worker-start'
import { WorkerStartParams } from './orchestration-worker-start-schema'
import { resolveOrchestrationCaller } from './orchestration-run-scope'
import {
  isWorkerStartTimeoutWithinTimerLimit,
  resolveWorkerStartReadinessTimeoutMs
} from '../../../../shared/orchestration-timing-budgets'
import {
  decideWorkerStartMode,
  readWorkerStartModeSettings
} from './orchestration-worker-start-mode'

export const ORCHESTRATION_WORKER_START_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.workerStart',
    params: WorkerStartParams,
    handler: async (
      params,
      { runtime, orchestrationMutation, orchestrationCompatibilityEvidence }
    ) => {
      if (!isWorkerStartTimeoutWithinTimerLimit(params.timeoutMs)) {
        throw new OrchestrationError(
          'invalid_argument',
          `--timeout-ms is too large for worker-start transport grace; the derived timeout must fit within the timer limit.`
        )
      }
      const readinessTimeoutMs = resolveWorkerStartReadinessTimeoutMs(params.timeoutMs)
      const db = runtime.getOrchestrationDb()
      // Why: worker-start was the only Run-scoped verb that skipped this, so a
      // declared --from could name someone else's pane and inherit their depth.
      const coordinatorPane = resolveOrchestrationCaller(runtime, {
        callerTerminalHandle: params.from,
        callerEvidence: orchestrationCompatibilityEvidence
      })
      const run = coordinatorPane ? db.getCurrentRunForPane(coordinatorPane) : undefined
      if (!run || (params.run && params.run !== run.id)) {
        throw new OrchestrationError(
          'consumer_fenced',
          'worker-start requires the coordinator terminal currently bound to the Task Run.'
        )
      }
      const task = db.getTask(params.task)
      if (!task || task.run_id !== run.id) {
        throw new OrchestrationError(
          'task_not_found',
          `Task ${params.task} was not found in Run ${run.id}.`
        )
      }

      const mode = decideWorkerStartMode({
        params,
        settings: readWorkerStartModeSettings(runtime),
        platform: process.platform
      })
      if (params.on) {
        // A remote worker is always a terminal agent; the mode receipt rides along so the
        // coordinator still learns why its structured default did not apply.
        const receipt = await startFederatedWorker({
          params,
          runtime,
          db,
          runId: run.id,
          task,
          orchestrationMutation
        })
        return receipt && typeof receipt === 'object' ? { ...receipt, mode } : receipt
      }
      return startLocalWorker({
        params,
        runtime,
        db,
        run,
        task,
        readinessTimeoutMs,
        orchestrationMutation,
        mode
      })
    }
  })
]
