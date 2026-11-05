import type { OrchestrationDb } from '../orchestration-db'
import { isDispatchAssignee } from '../dispatch-context/dispatch-lookup'

/** How much mail from above (the coordinator, or Orca for it) the worker has consumed, in any order.
 *  Reports its own helpers sent up to it, and mail it has not taken yet, do not count. */
export function readCoordinatorMailCount(db: OrchestrationDb, dispatchId: string): number {
  const helpers = db.db
    .prepare(
      'SELECT id, assignee_handle, assignee_pane_key FROM dispatch_contexts WHERE creator_dispatch_id = ?'
    )
    .all(dispatchId)
    .flatMap((row) =>
      typeof row.id === 'string' && typeof row.assignee_handle === 'string'
        ? [
            {
              id: row.id,
              assignee_handle: row.assignee_handle,
              assignee_pane_key:
                typeof row.assignee_pane_key === 'string' ? row.assignee_pane_key : null
            }
          ]
        : []
    )
  const senders = db.db
    .prepare('SELECT from_handle FROM messages WHERE to_handle = ? AND read = 1')
    .all(`dispatch:${dispatchId}`)
    .map((row) => (typeof row.from_handle === 'string' ? row.from_handle : ''))
  return senders.filter(
    (from) =>
      !helpers.some(
        (helper) => from === `dispatch:${helper.id}` || isDispatchAssignee(helper, from, null)
      )
  ).length
}
