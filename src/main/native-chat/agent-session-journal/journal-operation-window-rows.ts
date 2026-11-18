import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalSqlScope } from './journal-sql-scope'
import type { JournalOperationWindowAnchors } from './journal-domain-operation-window'
import { JOURNAL_READER_REPLY_BYTE_LIMIT } from './journal-sql-reader-reply-limit'
import { shortenedJsonSql } from './journal-stored-json-bounds'

// A Diff call's patch, and so the files it edited, is its output: that one is kept. The stored
// marker goes too, or decoding would read the saved output back in.
const WITHOUT_TOOL_OUTPUT = `CASE WHEN kind='tool-call' AND json_valid(payload_json)
  AND json_extract(payload_json,'$.body.name') IS NOT 'Diff'
  THEN json_remove(json_replace(payload_json,'$.body.output.head','','$.body.output.truncated',json('true')),
    '$.body.output.stored')
  ELSE payload_json END`

const TURN_SHAPE = `AND (kind IN ('message','turn','status') OR turn_scope_kind='unknown')`

// Rows share one reply: past this total, the largest have their tool output or patch cut.
const WINDOW_BYTES = JOURNAL_READER_REPLY_BYTE_LIMIT / 2
const CUT_ROW_BYTES = 64 * 1024

/**
 * The window's rows from `start`, sized in SQL before any is decoded, as the read projects them:
 * the largest are cut, keeping size and digest, until the rows fit one reply together. Diff calls
 * are cut last, since a cut patch can lose the names of files it edited.
 */
export function readOperationWindowItems(
  scope: JournalSqlScope,
  start: number,
  anchors: Pick<JournalOperationWindowAnchors, 'withoutToolOutput' | 'turnShape'>
): AgentJournalRenderItem[] {
  if (scope.db.isTransaction) {
    return readWindowItems(scope, start, anchors)
  }
  // Sizes and rows come from one snapshot, so a row can't grow between them.
  scope.db.exec('BEGIN')
  try {
    return readWindowItems(scope, start, anchors)
  } finally {
    scope.db.exec('COMMIT')
  }
}

function readWindowItems(
  scope: JournalSqlScope,
  start: number,
  anchors: Pick<JournalOperationWindowAnchors, 'withoutToolOutput' | 'turnShape'>
): AgentJournalRenderItem[] {
  const projected = anchors.withoutToolOutput ? WITHOUT_TOOL_OUTPUT : 'payload_json'
  const rows = `FROM journal_items INDEXED BY journal_items_visible_position
    WHERE session_id=? AND epoch=? AND hidden=0 AND sequence>=? ${anchors.turnShape ? TURN_SHAPE : ''}`
  // Plain sizes cost no parse; only a window past the budget sizes its large rows as projected.
  const sizes = scope.db
    .prepare(`SELECT item_id, octet_length(payload_json) AS bytes ${rows}`)
    .all(...scope.prefix, start)
    .map((row) => ({ itemId: String(row.item_id), bytes: Number(row.bytes), diff: false }))
  let total = sizes.reduce((sum, row) => sum + row.bytes, 0)
  const large = sizes.filter((row) => row.bytes > CUT_ROW_BYTES)
  if (total > WINDOW_BYTES && large.length > 0) {
    const measured = new Map(
      scope.db
        .prepare(`SELECT item_id, octet_length(${projected}) AS bytes,
          kind='tool-call' AND json_valid(payload_json)
            AND json_extract(payload_json,'$.body.name') IS 'Diff' AS diff
          FROM journal_items WHERE session_id=? AND epoch=?
            AND item_id IN (SELECT value FROM json_each(?))`)
        .all(...scope.prefix, JSON.stringify(large.map((row) => row.itemId)))
        .map((row) => [String(row.item_id), row])
    )
    for (const row of large) {
      const found = measured.get(row.itemId)
      total += Number(found?.bytes ?? row.bytes) - row.bytes
      row.bytes = Number(found?.bytes ?? row.bytes)
      row.diff = Boolean(found?.diff)
    }
  }
  // Largest first, Diff calls last: their patch names the files they edited. Each cut is
  // counted at the size it actually comes back at, which is whole when nothing could be cut.
  const cutSize = scope.db.prepare(`SELECT octet_length(${shortenedJsonSql(projected)}) AS bytes
    FROM journal_items WHERE session_id=? AND epoch=? AND item_id=?`)
  const cut: string[] = []
  for (const row of large.toSorted(
    (a, b) => Number(a.diff) - Number(b.diff) || b.bytes - a.bytes
  )) {
    if (row.bytes > WINDOW_BYTES || (total > WINDOW_BYTES && row.bytes > CUT_ROW_BYTES)) {
      cut.push(row.itemId)
      const shortened = cutSize.get(...scope.prefix, row.itemId)?.bytes
      if (typeof shortened === 'number') {
        total -= row.bytes - shortened
        row.bytes = shortened
      }
    }
  }
  if (total > JOURNAL_READER_REPLY_BYTE_LIMIT) {
    throw new Error(
      `journal operation window (${total} bytes after cutting) exceeds ${JOURNAL_READER_REPLY_BYTE_LIMIT} bytes`
    )
  }
  // A cut row whose bulk is not its output or patch comes back whole, within the total above.
  const value = cut.length
    ? `CASE WHEN item_id IN (SELECT value FROM json_each(?))
        THEN COALESCE(${shortenedJsonSql(projected)}, ${projected}) ELSE ${projected} END`
    : projected
  return scope.db
    .prepare(`SELECT ${value} AS payload_json ${rows} ORDER BY sequence,sequence_index,ordinal`)
    .all(...(cut.length ? [JSON.stringify(cut)] : []), ...scope.prefix, start)
    .map((row) => scope.decode<AgentJournalRenderItem>(scope.examined(row).payload_json))
}
