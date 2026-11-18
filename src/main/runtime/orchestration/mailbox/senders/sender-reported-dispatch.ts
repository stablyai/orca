import type { OrchestrationDb } from '../../db/orchestration-db'
import type { DispatchContextRow } from '../../db/orchestration-records'
import {
  getRemoteDispatch,
  type RemoteDispatchRow
} from '../../db/remote-owned/remote-dispatch-records'

/** Only the sender's own dispatch: a report's payload is the sender's to write. */
export function reportedDispatch(
  db: OrchestrationDb,
  dispatchId: string | undefined,
  handle: string,
  paneKey: string | undefined
): DispatchContextRow | undefined {
  const dispatch = dispatchId ? db.getDispatchContextById(dispatchId) : undefined
  return dispatch &&
    (dispatch.assignee_handle === handle ||
      (paneKey !== undefined && dispatch.assignee_pane_key === paneKey))
    ? dispatch
    : undefined
}

/** A paired server's worker: its terminal is unknown here, so its report alone names its Dispatch. */
export function reportedRemoteDispatch(
  db: OrchestrationDb,
  dispatchId: string | undefined
): RemoteDispatchRow | null {
  return (dispatchId ? getRemoteDispatch(db, dispatchId) : undefined) ?? null
}
