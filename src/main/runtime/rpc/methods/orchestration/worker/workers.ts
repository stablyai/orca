import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { defineMethod } from '../../../core'
import { startFederatedWorker } from '../federation/federated-worker-start'
import { startLocalWorker } from './local-worker-start'
import {
  decideWorkerStartMode,
  readWorkerStartModeSettings
} from '../../orchestration-worker-start-mode'
import { resolveOrchestrationCaller } from '../runs/run-scope'
import { WorkerStartParams } from './worker-start-schema'
import { resolveOrchestrationWorkerLaunchDefaults } from './worker-launch-preferences'
import {
  isWorkerStartTimeoutWithinTimerLimit,
  resolveWorkerStartReadinessTimeoutMs
} from '../../../../../../shared/orchestration-timing-budgets'
import { assertWorkerStartTaskSpecWithinPromptBudget } from './worker-start-prompt-budget'

export const ORCHESTRATION_WORKER_START_METHODS = [
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
          '--timeout-ms is too large for worker-start transport grace; the derived timeout must fit within the timer limit.'
        )
      }
      const readinessTimeoutMs = resolveWorkerStartReadinessTimeoutMs(params.timeoutMs)
      const db = runtime.getOrchestrationDb()
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
      const existingTask = params.task ? db.getTask(params.task) : undefined
      if (params.task && (!existingTask || existingTask.run_id !== run.id)) {
        throw new OrchestrationError(
          'task_not_found',
          `Task ${params.task} was not found in Run ${run.id}.`
        )
      }
      await assertWorkerStartTaskSpecWithinPromptBudget(params.spec ?? existingTask!.spec)
      const resolvedDefaults = resolveOrchestrationWorkerLaunchDefaults({
        terminal: params.terminal,
        agent: params.agent,
        model: params.model,
        effort: params.effort,
        defaults: runtime.getOrchestrationWorkerLaunchDefaults()
      })
      const launchParams = {
        ...params,
        ...(resolvedDefaults.agent !== undefined ? { agent: resolvedDefaults.agent } : {}),
        ...(resolvedDefaults.model !== undefined ? { model: resolvedDefaults.model } : {}),
        ...(resolvedDefaults.effort !== undefined ? { effort: resolvedDefaults.effort } : {})
      }
      // Why: the resolved defaults are the launch the mode receipt has to judge — a stored
      // model or effort only applies to a terminal agent, exactly as an explicit flag does,
      // and the stored agent is what decides whether a structured session exists at all.
      const mode = decideWorkerStartMode({
        params: launchParams,
        settings: readWorkerStartModeSettings(runtime)
      })
      if (params.on) {
        // A remote worker is always a terminal agent; the mode receipt rides along so the
        // coordinator still learns why its structured default did not apply.
        const receipt = await startFederatedWorker({
          params: launchParams,
          runtime,
          db,
          runId: run.id,
          task: existingTask,
          orchestrationMutation,
          defaultsApplied: resolvedDefaults.applied
        })
        return receipt && typeof receipt === 'object' ? { ...receipt, mode } : receipt
      }
      return startLocalWorker({
        params: { ...launchParams, timeoutMs: readinessTimeoutMs },
        runtime,
        db,
        run,
        coordinatorPane,
        existingTask,
        orchestrationMutation,
        mode
      })
    }
  })
]
