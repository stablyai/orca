import { isWorkerRestartOffered } from '../../db/worker-dispatch/worker-restart-resume'
import type { OrchestrationDb } from '../../db/orchestration-db'
import type { WorkerTurnStopDispatch, WorkerTurnStopReportDeps } from './worker-turn-stop-report'

/** The Dispatch a pane's worker runs now: its active local one, or the current remote attachment. */
export function resolveTerminalWorkerDispatch(
  deps: Pick<WorkerTurnStopReportDeps, 'getDb'> & {
    getHandle: (paneKey: string) => string | null
    getProcessIncarnation: (handle: string) => string | null
  },
  paneKey: string
): {
  db: OrchestrationDb
  handle: string
  target: WorkerTurnStopDispatch
} | null {
  const db = deps.getDb()
  const handle = db ? deps.getHandle(paneKey) : null
  if (!db || !handle) {
    return null
  }
  const dispatch = db.getActiveDispatchForTerminal(handle, paneKey)
  if (dispatch) {
    // Its resume waits on a person, as a cut chat's does: nothing tells its coordinator until they act.
    return isWorkerRestartOffered(db, dispatch.id)
      ? null
      : { db, handle, target: { kind: 'local', dispatch } }
  }
  // A paired server holds its remote workers as attachments; their Dispatch lives at the Run home.
  const attachment = db.findActiveRemoteAttachmentForPane(paneKey)
  return attachment &&
    db.isRemoteAttachmentProcessCurrent({
      dispatchId: attachment.dispatch_id,
      paneKey,
      processIncarnation: deps.getProcessIncarnation(handle)
    })
    ? { db, handle, target: { kind: 'remote', attachment } }
    : null
}
