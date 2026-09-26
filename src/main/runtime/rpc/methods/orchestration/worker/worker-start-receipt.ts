import type { OrchestrationDb } from '../../../../orchestration/db'
import { isAgentPromptStalledError } from '../../../../agent-prompt-submission-verification'
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
  // Only name cleanup this start actually left behind: a terminal it created and still owns. A
  // structured session is discarded by the teardown, a pane the user typed into is theirs, and an
  // unknown outcome is not settled — none of the three has anything for `worker-release` to close.
  const residual = unknown ? undefined : args.db.getWorkerTerminalResourceByOwner(args.dispatchId)
  const releasable =
    residual?.ownership_state === 'owned' && !isStructuredWorkerHandle(residual.terminal_handle)
  return {
    ...workerStartReceipt(args, worker),
    state: worker.state === 'start_unknown' ? 'outcome_unknown' : worker.state,
    failedStage: args.failedStage,
    lastError: reason,
    ...(releasable
      ? {
          recovery: `This start created a terminal that never ran the Task. Close it with: orca orchestration worker-release --dispatch ${args.dispatchId}`
        }
      : {}),
    ...(unknown ? { nextCommands: unknownWorkerStartNextCommands(args.dispatchId) } : {})
  }
}

type WorkerStartReceiptArgs = Omit<
  Parameters<typeof failWorkerStartWithReceipt>[0],
  'error' | 'failedStage'
>

/**
 * A start still running when its caller can wait no longer: the worker's durable state,
 * `starting`, as worker-show reports it, and nothing written. The start runs on and settles the
 * worker ready, unknown or failed exactly as it would have.
 */
export function inProgressWorkerStartReceipt(args: WorkerStartReceiptArgs): unknown {
  const worker = args.db.getWorkerDispatch(args.dispatchId)
  if (!worker) {
    throw new Error(`Worker Dispatch ${args.dispatchId} was not found.`)
  }
  return {
    ...workerStartReceipt(args, worker),
    state: 'starting',
    nextCommands: startingWorkerNextCommands(args.dispatchId)
  }
}

/** What to run on a worker whose start has not settled yet. */
export function startingWorkerNextCommands(dispatchId: string): string[] {
  return [`orca orchestration worker-show --dispatch ${dispatchId} --json`]
}

function workerStartReceipt(
  args: WorkerStartReceiptArgs,
  worker: { stage: string; effects: string; residual_resources: string }
) {
  return {
    runId: args.runId,
    taskId: args.taskId,
    dispatchId: args.dispatchId,
    stage: worker.stage,
    setup: args.setup,
    launch: args.launch,
    mode: args.mode,
    effects: parseJsonArray(worker.effects),
    residualResources: parseJsonArray(worker.residual_resources)
  }
}

function parseJsonArray(text: string): unknown[] {
  const parsed: unknown = JSON.parse(text)
  return Array.isArray(parsed) ? parsed : []
}

function unknownWorkerStartNextCommands(dispatchId: string): string[] {
  return [
    `orca orchestration worker-show --dispatch ${dispatchId} --json`,
    `orca orchestration worker-abandon --dispatch ${dispatchId} --json`
  ]
}
