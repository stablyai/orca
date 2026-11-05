import type { OrchestrationDb } from '../orchestration-db'
import { isDispatchAssignee } from '../dispatch-context/dispatch-lookup'
import { exposeUtcTimestamp } from '../utc-timestamp'

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** How much mail from above (the coordinator, or Orca for it) the worker has consumed, in any order.
 *  A helper's reports up to it while it was open, and mail it has not taken yet, do not count. */
export function readCoordinatorMailCount(db: OrchestrationDb, dispatchId: string): number {
  const helpers = db.db
    .prepare(
      `SELECT id, assignee_handle, assignee_pane_key, completed_at FROM dispatch_contexts
        WHERE creator_dispatch_id = ?`
    )
    .all(dispatchId)
    .flatMap((row) => {
      const id = text(row.id)
      const handle = text(row.assignee_handle)
      return id && handle
        ? [
            {
              id,
              assignee_handle: handle,
              assignee_pane_key: text(row.assignee_pane_key),
              completedAt: Date.parse(text(row.completed_at) ?? '')
            }
          ]
        : []
    })
  const read = db.db
    .prepare(
      'SELECT from_handle, sender_pane_key, created_at FROM messages WHERE to_handle = ? AND read = 1'
    )
    .all(`dispatch:${dispatchId}`)
  return read.filter((message) => {
    const from = text(message.from_handle) ?? ''
    const sentAt = Date.parse(exposeUtcTimestamp(text(message.created_at)) ?? '')
    // A settled helper can go on to coordinate the Run; only what it sent while helping is a report.
    return !helpers.some(
      (helper) =>
        (Number.isNaN(helper.completedAt) || sentAt <= helper.completedAt) &&
        (from === `dispatch:${helper.id}` ||
          isDispatchAssignee(helper, from, text(message.sender_pane_key)))
    )
  }).length
}
