import type { JournalSqlScope } from './journal-sql-scope'
import { JournalSqlPlaceIndex } from './journal-sql-place-index'

const PAGE = 128

/** Drive related item/group metadata, never the historical submission payload population. */
export function* sqlStatusRelatedInputIds(
  scope: JournalSqlScope,
  start: number,
  floor: number
): Iterable<string> {
  let cursor = [floor, 0, -1]
  for (;;) {
    const rows = scope.db
      .prepare(`SELECT i.sequence,i.sequence_index,i.ordinal,s.client_message_id
      FROM journal_proj_items i LEFT JOIN journal_proj_submissions s
      ON s.session_id=i.session_id AND s.epoch=i.epoch AND s.current=1 AND s.item_key=i.entry_key
      AND s.input_ordinal>=?
      WHERE i.session_id=? AND i.epoch=? AND i.hidden=0 AND i.root=1
      AND i.message_role='user' AND i.command_entry=0 AND i.sequence>?
      AND (i.sequence,i.sequence_index,i.ordinal)>(?,?,?)
      ORDER BY i.sequence,i.sequence_index,i.ordinal LIMIT ?`)
      .all(start, ...scope.prefix, floor, ...cursor, PAGE)
    for (const row of rows) {
      scope.examined(row)
      if (row.client_message_id !== null) {
        yield String(row.client_message_id)
      }
    }
    const last = rows.at(-1)
    if (rows.length < PAGE || !last) {
      break
    }
    cursor = [Number(last.sequence), Number(last.sequence_index), Number(last.ordinal)]
  }
  let after = -1
  for (;;) {
    const rows = scope.db
      .prepare(`SELECT ordinal,turn_id FROM journal_proj_steer_groups
      WHERE session_id=? AND epoch=? AND ordinal>? ORDER BY ordinal LIMIT ?`)
      .all(...scope.prefix, after, PAGE)
    for (const row of rows) {
      scope.examined(row)
      const item = scope.db
        .prepare(`SELECT entry_key FROM journal_proj_items
        WHERE session_id=? AND epoch=? AND entry_key=? AND hidden=0`)
        .get(...scope.prefix, JSON.stringify(row.turn_id))
      if (!item) {
        continue
      }
      scope.examined(item)
      const id = new JournalSqlPlaceIndex(scope, `steers:${JSON.stringify(row.turn_id)}`).lastId()
      if (id !== undefined) {
        yield id
      }
    }
    const last = rows.at(-1)
    if (rows.length < PAGE || !last) {
      return
    }
    after = Number(last.ordinal)
  }
}
