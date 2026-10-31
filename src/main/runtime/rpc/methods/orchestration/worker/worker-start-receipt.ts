import { formatTerminalStartFailure } from '../../../../../../shared/terminal-start-failure'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { WorkerDispatchRow } from '../../../../orchestration/types'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { tearDownFailedWorkerStart } from './failed-worker-start-teardown'
import {
  isUnknownWorkerStartOutcome,
  type createStructuredWorkerSessionForWorktree,
  type WorkerSetupReceipt
} from './worker-topology'
import type { OrchestrationWorkerLaunchReceipt } from './worker-launch-preferences'
import type { WorkerStartModeReceipt } from '../../orchestration-worker-start-mode'
import { isStructuredWorkerHandle } from '../../../../../../shared/structured-worker-handle'

type WorkerStartFailureArgs = {
  runtime: OrcaRuntimeService
  structuredSession: Awaited<ReturnType<typeof createStructuredWorkerSessionForWorktree>> | null
  db: OrchestrationDb
  runId: string
  taskId: string
  dispatchId: string
  failedStage: string
  error: unknown
  setup: WorkerSetupReceipt
  launch: OrchestrationWorkerLaunchReceipt
  mode: WorkerStartModeReceipt
}

/** A worker report settles the Task; that proves the start, so older callers still see 'ready'. */
export function reportedWorkerOutcome(
  worker: WorkerDispatchRow | undefined
): 'succeeded' | 'failed' | undefined {
  return worker?.stage === 'settled' && (worker.state === 'succeeded' || worker.state === 'failed')
    ? worker.state
    : undefined
}

function settledWorkerStartReceipt(args: WorkerStartFailureArgs): unknown {
  const worker = args.db.getWorkerDispatch(args.dispatchId)
  const workerOutcome = reportedWorkerOutcome(worker)
  if (!worker || !workerOutcome) {
    return undefined
  }
  return {
    runId: args.runId,
    taskId: args.taskId,
    dispatchId: args.dispatchId,
    state: 'ready',
    stage: worker.stage,
    workerOutcome,
    setup: args.setup,
    launch: args.launch,
    mode: args.mode,
    effects: JSON.parse(worker.effects),
    residualResources: []
  }
}

export async function failWorkerStartWithReceipt(args: WorkerStartFailureArgs): Promise<unknown> {
  // A report that settled the Task outranks a late startup error, and keeps its session alive.
  const settled = settledWorkerStartReceipt(args)
  if (settled) {
    return settled
  }
  try {
    // Fail before awaiting teardown, so no report can settle between that check and this transition.
    return failedWorkerStartReceipt(args)
  } finally {
    await tearDownFailedWorkerStart({
      runtime: args.runtime,
      structuredSession: args.structuredSession,
      dispatchId: args.dispatchId
    })
  }
}

function failedWorkerStartReceipt(args: WorkerStartFailureArgs): unknown {
  const reason =
    formatTerminalStartFailure(args.error) ??
    (args.error instanceof Error ? args.error.message : String(args.error))
  const unknown = isUnknownWorkerStartOutcome(args.error, args.failedStage)
  const worker = unknown
    ? args.db.markWorkerStartUnknown(args.dispatchId, args.failedStage, reason)
    : args.db.failWorkerStart(args.dispatchId, args.failedStage, reason)
  // Offer cleanup only for this start's created, still-owned terminal; structured teardown, user takeover and unsettled unknown outcomes need none here.
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
