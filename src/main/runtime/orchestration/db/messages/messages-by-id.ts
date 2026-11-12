import type { OrchestrationDb } from '../orchestration-db'
import type { MessageRow } from '../orchestration-records'
import { MESSAGE_COLUMN_LIST } from '../row-column-lists'
import { exposeMessageListTimestamps } from '../utc-timestamp'

/** One read for a batch of ids, keyed by id; unknown ids are absent. */
export function getMessagesByIds(
  db: OrchestrationDb,
  ids: readonly string[]
): Map<string, MessageRow> {
  if (ids.length === 0) {
    return new Map()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the column list names every MessageRow column.
  const rows = db.db
    .prepare(
      `SELECT ${MESSAGE_COLUMN_LIST} FROM messages WHERE id IN (SELECT value FROM json_each(?))`
    )
    .all(JSON.stringify(ids)) as MessageRow[]
  return new Map(exposeMessageListTimestamps(rows).map((row) => [row.id, row]))
}
