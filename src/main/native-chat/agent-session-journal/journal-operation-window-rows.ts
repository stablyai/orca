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
 * the largest are cut, keeping size and digest, until the rows fit one reply together. A Diff
 * call's patch names the files it edited, so it is cut only when it alone is past half a reply.
 */
export function readOperationWindowItems(
  scope: JournalSqlScope,
  start: number,
  anchors: Pick<JournalOperationWindowAnchors, 'withoutToolOutput' | 'turnShape'>
): AgentJournalRenderItem[] {
  const projected = anchors.withoutToolOutput ? WITHOUT_TOOL_OUTPUT : 'payload_json'
  const rows = `FROM journal_items INDEXED BY journal_items_visible_position
    WHERE session_id=? AND epoch=? AND hidden=0 AND sequence>=? ${anchors.turnShape ? TURN_SHAPE : ''}`
  const sizes = scope.db
    .prepare(`SELECT item_id,
      CASE WHEN octet_length(payload_json)<=${CUT_ROW_BYTES} THEN 0
        ELSE kind='tool-call' AND json_valid(payload_json)
          AND json_extract(payload_json,'$.body.name') IS 'Diff' END AS diff,
      CASE WHEN octet_length(payload_json)<=${CUT_ROW_BYTES} THEN octet_length(payload_json)
        ELSE octet_length(${projected}) END AS bytes ${rows}`)
    .all(...scope.prefix, start)
    .map((row) => ({
      itemId: String(row.item_id),
      diff: Boolean(row.diff),
      bytes: Number(row.bytes)
    }))
  let total = sizes.reduce((sum, row) => sum + row.bytes, 0)
  const cut: string[] = []
  for (const row of sizes.toSorted(
    (a, b) => Number(a.diff) - Number(b.diff) || b.bytes - a.bytes
  )) {
    if (
      row.bytes > WINDOW_BYTES ||
      (total > WINDOW_BYTES && !row.diff && row.bytes > CUT_ROW_BYTES)
    ) {
      cut.push(row.itemId)
      total -= row.bytes - CUT_ROW_BYTES
    }
  }
  // A cut row whose bulk is not its output or patch stays whole; the reply limit still refuses it.
  const value = cut.length
    ? `CASE WHEN item_id IN (SELECT value FROM json_each(?))
        THEN COALESCE(${shortenedJsonSql(projected)}, ${projected}) ELSE ${projected} END`
    : projected
  return scope.db
    .prepare(`SELECT ${value} AS payload_json ${rows} ORDER BY sequence,sequence_index,ordinal`)
    .all(...(cut.length ? [JSON.stringify(cut)] : []), ...scope.prefix, start)
    .map((row) => scope.decode<AgentJournalRenderItem>(scope.examined(row).payload_json))
}
