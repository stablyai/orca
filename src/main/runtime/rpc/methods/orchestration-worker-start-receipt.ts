import type { OrchestrationDb } from '../../orchestration/db'
import { isAgentPromptStalledError } from '../../agent-prompt-submission-verification'
import {
  isUnknownWorkerStartOutcome,
  type WorkerSetupReceipt
} from './orchestration-worker-topology'
import type { OrchestrationWorkerLaunchReceipt } from './orchestration-worker-launch-preferences'

export function failWorkerStartWithReceipt(args: {
  db: OrchestrationDb
  runId: string
  taskId: string
  dispatchId: string
  failedStage: string
  error: unknown
  setup: WorkerSetupReceipt
  launch: OrchestrationWorkerLaunchReceipt
}): unknown {
  const reason = args.error instanceof Error ? args.error.message : String(args.error)
  const unknown = isUnknownWorkerStartOutcome(args.error, args.failedStage)
  const worker = unknown
    ? args.db.markWorkerStartUnknown(args.dispatchId, args.failedStage, reason)
    : args.db.failWorkerStart(args.dispatchId, args.failedStage, reason, {
        // Why (#16095): the preamble is written before submission is verified, so a stalled
        // verdict never means the worker lacks its task — keep the authority its report needs.
        retainCapability: isAgentPromptStalledError(args.error)
      })
  return {
    runId: args.runId,
    taskId: args.taskId,
    dispatchId: args.dispatchId,
    state: worker.state === 'start_unknown' ? 'outcome_unknown' : worker.state,
    stage: worker.stage,
    failedStage: args.failedStage,
    lastError: reason,
    setup: args.setup,
    launch: args.launch,
    effects: JSON.parse(worker.effects) as unknown[],
    residualResources: JSON.parse(worker.residual_resources) as unknown[],
    ...(unknown
      ? {
          nextCommands: [
            `orca orchestration worker-show --dispatch ${args.dispatchId} --json`,
            `orca orchestration worker-abandon --dispatch ${args.dispatchId} --json`
          ]
        }
      : {})
  }
}
