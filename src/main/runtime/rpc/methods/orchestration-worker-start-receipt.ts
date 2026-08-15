import type { OrchestrationDb } from '../../orchestration/db'
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
  bounded: {
    deadlineAt: string
    budget: unknown
    leafControl: unknown
  }
}): unknown {
  const reason = args.error instanceof Error ? args.error.message : String(args.error)
  const settled = args.db.getWorkerDispatch(args.dispatchId)
  if (settled && ['stopped', 'stop_unknown'].includes(settled.state)) {
    return {
      runId: args.runId,
      taskId: args.taskId,
      dispatchId: args.dispatchId,
      state: settled.state === 'stop_unknown' ? 'outcome_unknown' : settled.state,
      stage: settled.stage,
      failedStage: settled.stage,
      lastError: settled.last_error,
      setup: args.setup,
      launch: args.launch,
      deadlineAt: args.bounded.deadlineAt,
      budget: args.bounded.budget,
      leafControl: args.bounded.leafControl,
      effects: JSON.parse(settled.effects) as unknown[],
      residualResources: JSON.parse(settled.residual_resources) as unknown[]
    }
  }
  const unknown = isUnknownWorkerStartOutcome(args.error, args.failedStage)
  const worker = unknown
    ? args.db.markWorkerStartUnknown(args.dispatchId, args.failedStage, reason)
    : args.db.failWorkerStart(args.dispatchId, args.failedStage, reason)
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
    deadlineAt: args.bounded.deadlineAt,
    budget: args.bounded.budget,
    leafControl: args.bounded.leafControl,
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

export function federatedUnknownReceipt(
  worker: { dispatch_id: string; state: string; stage: string; last_error: string | null },
  taskId: string,
  serverName: string,
  launch: OrchestrationWorkerLaunchReceipt,
  bounded: {
    deadlineAt: string
    budget: unknown
    leafControl: unknown
  }
): unknown {
  return {
    taskId,
    dispatchId: worker.dispatch_id,
    state: 'outcome_unknown',
    stage: worker.stage,
    server: { name: serverName },
    launch,
    deadlineAt: bounded.deadlineAt,
    budget: bounded.budget,
    leafControl: bounded.leafControl,
    failedStage: worker.stage,
    lastError: worker.last_error,
    effects: [],
    residualResources: [],
    nextCommands: [
      `orca orchestration worker-show --dispatch ${worker.dispatch_id} --json`,
      `orca orchestration worker-abandon --dispatch ${worker.dispatch_id} --json`
    ]
  }
}
