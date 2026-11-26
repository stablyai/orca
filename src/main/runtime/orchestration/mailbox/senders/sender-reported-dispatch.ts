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

/** A paired server's worker, named only by a Dispatch the import recorded for this sender's own mail,
 *  or by its own `dispatch:` address, which this Orca writes on mail it files about that Dispatch. */
export function reportedRemoteDispatch(
  db: OrchestrationDb,
  dispatchId: string | undefined,
  senderAddress: string
): RemoteDispatchRow | null {
  if (senderAddress.startsWith('dispatch:')) {
    return getRemoteDispatch(db, senderAddress.slice('dispatch:'.length)) ?? null
  }
  const imported =
    dispatchId !== undefined &&
    db.db
      .prepare(
        `SELECT 1 FROM message_dispatch_provenance p JOIN messages m ON m.id = p.message_id
         WHERE p.dispatch_id = ? AND m.from_handle = ? LIMIT 1`
      )
      .get(dispatchId, senderAddress) !== undefined
  return (imported ? getRemoteDispatch(db, dispatchId) : undefined) ?? null
}
