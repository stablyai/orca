import type { OrcaRuntimeService } from '../../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import type { WorkerStopReceipt } from '../../../../../../../shared/orchestration/workers/orchestration-worker-stop-receipt'
import type { StructuredWorkerIdentity } from '../../../../../orchestration/terminal-authority/structured-sessions/structured-worker-identity'
import { stopStructuredWorker } from '../../structured-workers/orchestration-structured-worker-lifecycle'

/** Stops a worker that runs as a chat session; one whose agent is still starting stops once that start ends. */
export async function stopStructuredDispatch(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  dispatchId: string,
  structured: StructuredWorkerIdentity
): Promise<WorkerStopReceipt> {
  const stop = await stopStructuredWorker(structured, runtime)
  if (!stop.stopped && stop.whenStartEnds) {
    // Its agent is still starting: the stop stays pending until that start ends, never blocking here.
    void stop.whenStartEnds.then((ended) =>
      settleStopOfCancelledStart(runtime, db, dispatchId, ended)
    )
    return {
      dispatchId,
      state: db.getWorkerDispatch(dispatchId)?.state ?? 'stopping',
      alreadySettled: false,
      processAction: 'closed_agent_terminal',
      ...(stop.reason ? { reason: stop.reason } : {})
    }
  }
  if (!stop.stopped) {
    // Only proven exit settles; if no close was issued, the receipt must not claim one.
    return unknownReceipt(
      dispatchId,
      db.markWorkerStopUnknown(dispatchId, stop.reason ?? 'The close was not proven.'),
      stop.closeAttempted ? 'closed_agent_terminal' : 'none'
    )
  }
  // Closing the chat already settles the stop, as a terminal's exit does.
  if (db.getWorkerDispatch(dispatchId)?.state !== 'stopped') {
    db.settleWorkerStop(dispatchId)
  }
  runtime.notifyMessageArrived(`dispatch:${dispatchId}`, 'status')
  return {
    dispatchId,
    state: db.getWorkerDispatch(dispatchId)?.state ?? 'stopped',
    alreadySettled: false,
    processAction: 'closed_agent_terminal',
    ...(stop.reason ? { reason: stop.reason } : {})
  }
}

/** The pending stop of a worker whose agent was still starting, once that start has ended. */
function settleStopOfCancelledStart(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  dispatchId: string,
  ended: { stopped: true } | { stopped: false; reason: string }
): void {
  try {
    // The agent's own exit may already have settled it.
    if (db.getWorkerDispatch(dispatchId)?.state === 'stopping') {
      if (ended.stopped) {
        db.settleWorkerStop(dispatchId)
      } else {
        db.markWorkerStopUnknown(dispatchId, ended.reason)
      }
    }
    runtime.notifyMessageArrived(`dispatch:${dispatchId}`, 'status')
  } catch (error) {
    console.warn('[orchestration] settling the stop of a starting worker failed', dispatchId, error)
  }
}

export function unknownReceipt(
  dispatchId: string,
  worker: { state: string; last_error: string | null },
  processAction: string
): WorkerStopReceipt {
  return {
    dispatchId,
    state: worker.state,
    alreadySettled: false,
    processAction,
    lastError: worker.last_error
  }
}
