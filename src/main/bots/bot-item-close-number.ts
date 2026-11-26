// Each close of an item is numbered on its status event, 1 for its first: the journal tells one close
// from another by it, however many came the same day, after a restart, or in another time zone.
import type SyncDatabase from '../sqlite/sync-database'

/** A status event's data that closes an open item. */
const CLOSES = `json_extract(data, '$.to') IN ('done', 'canceled')
  AND json_extract(data, '$.from') NOT IN ('done', 'canceled')`

/** `data` with its close number when the event closes an open item; a move between closed
 *  statuses is no new close. Reads only the item's status events since its last close. */
export function withCloseNumber(
  db: SyncDatabase,
  uid: string,
  data: Record<string, unknown>
): Record<string, unknown> {
  const closing = (status: unknown) => status === 'done' || status === 'canceled'
  if (!closing(data.to) || closing(data.from)) {
    return data
  }
  const last = db
    .prepare(
      `SELECT json_extract(data, '$.closeNumber') AS number FROM item_events
       WHERE item_uid = ? AND kind = 'status' AND ${CLOSES} ORDER BY created_at DESC, id DESC LIMIT 1`
    )
    .get(uid)
  if (!last) {
    return { ...data, closeNumber: 1 }
  }
  if (typeof last.number === 'number') {
    return { ...data, closeNumber: last.number + 1 }
  }
  // Closes from before Orca numbered them are counted once; later closes number from the last.
  const count = db
    .prepare(
      `SELECT COUNT(*) AS count FROM item_events WHERE item_uid = ? AND kind = 'status' AND ${CLOSES}`
    )
    .get(uid)
  return { ...data, closeNumber: Number(count?.count ?? 0) + 1 }
}
