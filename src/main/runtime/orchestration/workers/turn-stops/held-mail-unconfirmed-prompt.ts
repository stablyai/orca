import type { OrchestrationDb } from '../../db/orchestration-db'
import { observeWorker } from './worker-presence-report'
import type { WorkerTurnStopReportDeps } from './worker-turn-stop-report'

/** Mail typed into a worker's terminal waits for its agent to paint after a reattach. Where its host
 *  cannot ask for that paint and nothing proves the retained frame, only the user can lift the hold,
 *  so the coordinator is told once per reattach (`fence`); the worker's next turn supersedes it. */
export function observeMailHeldWithoutPaint(
  db: OrchestrationDb,
  dispatchId: string,
  fence: string,
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
  observeWorker(
    db,
    { kind: 'local', dispatch },
    {
      presence: 'at-rest',
      fence,
      legacyStopKey: fence,
      rest: { from: dispatch.assignee_handle, reason: 'mail-held', lastOutput: undefined }
    },
    deps
  )
}
