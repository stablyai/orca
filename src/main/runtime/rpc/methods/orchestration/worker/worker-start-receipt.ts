import type { OrchestrationDb } from '../../../../orchestration/db'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { isUnknownWorkerStartOutcome, type WorkerSetupReceipt } from './worker-topology'
import type { OrchestrationWorkerLaunchReceipt } from './worker-launch-preferences'
import type { WorkerStartModeReceipt } from '../../orchestration-worker-start-mode'
import { isStructuredWorkerHandle } from '../../../../structured-worker-identity'

export function failWorkerStartWithReceipt(args: {
  db: OrchestrationDb
  runId: string
  taskId: string
  dispatchId: string
  failedStage: string
  error: unknown
  setup: WorkerSetupReceipt
  launch: OrchestrationWorkerLaunchReceipt
  mode: WorkerStartModeReceipt
}) {
  const readSettledReceipt = () => {
    // A settled result proves startup happened even when its prompt acknowledgement was lost.
    const settled = args.db.getWorkerDispatch(args.dispatchId)
    if (
      settled?.stage === 'settled' &&
      (settled.state === 'succeeded' || settled.state === 'failed')
    ) {
      const effects: unknown[] = JSON.parse(settled.effects)
      return {
        runId: args.runId,
        taskId: args.taskId,
        dispatchId: args.dispatchId,
        state: 'ready' as const,
        stage: settled.stage,
        workerOutcome: settled.state,
        setup: args.setup,
        launch: args.launch,
        mode: args.mode,
        effects,
        residualResources: []
      }
    }
  }
  const settled = readSettledReceipt()
  if (settled) {
    return settled
  }
  const reason = args.error instanceof Error ? args.error.message : String(args.error)
  const unknown = isUnknownWorkerStartOutcome(args.error, args.failedStage)
  let worker
  try {
    worker = unknown
      ? args.db.markWorkerStartUnknown(args.dispatchId, args.failedStage, reason)
      : args.db.failWorkerStart(args.dispatchId, args.failedStage, reason)
  } catch (error) {
    if (error instanceof OrchestrationError && error.code === 'dispatch_inactive') {
      // Another connection can settle the report between the initial read and the transition.
      const raced = readSettledReceipt()
      if (raced) {
        return raced
      }
    }
    throw error
  }
  // Only name cleanup this start actually left behind: a terminal it created and still owns. A
  // structured session is discarded by the teardown, a pane the user typed into is theirs, and an
  // unknown outcome is not settled — none of the three has anything for `worker-release` to close.
  const residual = unknown ? undefined : args.db.getWorkerTerminalResourceByOwner(args.dispatchId)
  const releasable =
    residual?.ownership_state === 'owned' && !isStructuredWorkerHandle(residual.terminal_handle)
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
    mode: args.mode,
    effects: JSON.parse(worker.effects) as unknown[],
    residualResources: JSON.parse(worker.residual_resources) as unknown[],
    ...(releasable
      ? {
          recovery: `This start created a terminal that never ran the Task. Close it with: orca orchestration worker-release --dispatch ${args.dispatchId}`
        }
      : {}),
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
