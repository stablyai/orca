import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { defineMethod } from '../../../core'
import { startFederatedWorker } from '../federation/federated-worker-start'
import { startLocalWorker } from './local-worker-start'
import {
  decideWorkerStartMode,
  readWorkerStartModeSettings
} from '../../orchestration-worker-start-mode'
import { resolveOrchestrationCaller } from '../runs/run-scope'
import { assertHelperStartScope, resolveWorkerStartRun } from './worker-start-authority'
import { WorkerStartParams } from '../../../../../../shared/rpc-contract/orchestration-worker-start-params'
import {
  isWorkerStartTimeoutWithinTimerLimit,
  resolveWorkerStartReadinessTimeoutMs
} from '../../../../../../shared/orchestration-timing-budgets'
import { assertWorkerStartTaskSpecWithinPromptBudget } from './worker-start-prompt-budget'
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../../../../../shared/orca-session-address'
import { ORCHESTRATION_SESSION_CALLER_ERROR_CODES as SESSION_CODES } from '../../../../../../shared/orchestration-session-caller-codes'

export const ORCHESTRATION_WORKER_START_METHODS = [
  defineMethod({
    name: 'orchestration.workerStart',
    permission: 'workspace',
    params: WorkerStartParams,
    handler: async (
      params,
      { runtime, orchestrationMutation, orchestrationCompatibilityEvidence, orchestrationCaller }
    ) => {
      if (!isWorkerStartTimeoutWithinTimerLimit(params.timeoutMs)) {
        throw new OrchestrationError(
          'invalid_argument',
          '--timeout-ms is too large for worker-start transport grace; the derived timeout must fit within the timer limit.'
        )
      }
      const readinessTimeoutMs = resolveWorkerStartReadinessTimeoutMs(params.timeoutMs)
      const db = runtime.getOrchestrationDb()
      const coordinator = resolveOrchestrationCaller(runtime, {
        callerTerminalHandle: params.from,
        callerEvidence: orchestrationCompatibilityEvidence,
        callerSession: orchestrationCaller
      })
      const { run, helperCreator } = resolveWorkerStartRun(runtime, {
        coordinator,
        from: params.from,
        callerSession: orchestrationCaller,
        runId: params.run
      })
      const existingTask = params.task ? db.getTask(params.task) : undefined
      if (params.task && (!existingTask || existingTask.run_id !== run.id)) {
        throw new OrchestrationError(
          'task_not_found',
          `Task ${params.task} was not found in Run ${run.id}.`
        )
      }
      if (helperCreator) {
        assertHelperStartScope(db, helperCreator, { task: existingTask, params })
      }
      await assertWorkerStartTaskSpecWithinPromptBudget(params.spec ?? existingTask!.spec)
      const mode = decideWorkerStartMode({
        params,
        settings: readWorkerStartModeSettings(runtime)
      })
      if (params.on && params.terminal?.startsWith(ORCA_SESSION_ADDRESS_PREFIX)) {
        // Refused here, before any remote call: an Orca session ID names a chat only on its own host.
        throw new OrchestrationError(
          SESSION_CODES.hostBoundary,
          `${params.terminal} names a chat by its Orca session ID, which identifies it only on the host that runs it. Run worker-start on that host. No effects were applied.`,
          { effectsApplied: false }
        )
      }
      if (params.on) {
        // Remote workers are terminal-only; carry the mode receipt to explain structured-preference fallback.
        const receipt = await startFederatedWorker({
          params,
          runtime,
          db,
          runId: run.id,
          task: existingTask,
          orchestrationMutation,
          callerSession: orchestrationCaller
        })
        return receipt && typeof receipt === 'object' ? { ...receipt, mode } : receipt
      }
      return startLocalWorker({
        params: { ...params, timeoutMs: readinessTimeoutMs },
        runtime,
        db,
        run,
        coordinator,
        callerSession: orchestrationCaller,
        existingTask,
        orchestrationMutation,
        mode,
        helperCreator
      })
    }
  })
]
