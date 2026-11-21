import type { OrchestrationDb } from '../../db/orchestration-db'
import {
  sendWorkerReport,
  stopReportId,
  type WorkerTurnStopReportDeps
} from './worker-turn-stop-report'

/** Mail typed into a worker's terminal waits for its agent to paint after a reattach. Where its host
 *  cannot ask for that paint and nothing proves the retained frame, only the user can lift the hold,
 *  so the coordinator is told once per hold: `holdKey` names the reattach, and the report's stable
 *  id makes a second report of it a no-op. The worker's presence (its own rests) is left alone. */
export function reportMailHeldWithoutPaint(
  db: OrchestrationDb,
  dispatchId: string,
  holdKey: string,
  deps: WorkerTurnStopReportDeps
): void {
  const dispatch = db.getDispatchContextById(dispatchId)
  if (
    !dispatch?.assignee_handle ||
    (dispatch.status !== 'pending' && dispatch.status !== 'dispatched') ||
    db.getFederatedDispatch(dispatchId)
  ) {
    return
  }
  sendWorkerReport(
    db,
    { kind: 'local', dispatch },
    { from: dispatch.assignee_handle, reason: 'mail-held', lastOutput: undefined },
    stopReportId(dispatchId, holdKey),
    deps
  )
}
