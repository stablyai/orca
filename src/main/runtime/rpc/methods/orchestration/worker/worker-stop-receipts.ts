import type { WorkerStopReceipt } from '../../../../../../shared/orchestration/workers/orchestration-worker-stop-receipt'

export function settledReceipt(dispatchId: string, state: string): WorkerStopReceipt {
  return { dispatchId, state, alreadySettled: true, processAction: 'none' }
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
