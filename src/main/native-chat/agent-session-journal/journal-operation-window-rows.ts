import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalSqlScope } from './journal-sql-scope'
import type { JournalOperationWindowAnchors } from './journal-domain-operation-window'
import { JOURNAL_READER_REPLY_BYTE_LIMIT } from './journal-sql-reader-reply-limit'
import { shortenJournalItemHead, shortenedJsonSql } from './journal-stored-json-bounds'
import { journalStoredTextBytesSql } from './journal-stored-output-rows'

// A Diff call's patch, and so the files it edited, is its output: that one is kept. The stored
// marker goes too, or decoding would read the saved output back in.
const DROPS_TOOL_OUTPUT = `kind='tool-call' AND json_valid(payload_json)
  AND json_extract(payload_json,'$.body.name') IS NOT 'Diff'`
const WITHOUT_TOOL_OUTPUT = `CASE WHEN ${DROPS_TOOL_OUTPUT}
  THEN json_remove(json_replace(payload_json,'$.body.output.head','','$.body.output.truncated',json('true')),
    '$.body.output.stored')
  ELSE payload_json END`

// Stored rows read back with their whole text, so they are sized at it.
const STORED_TEXT = journalStoredTextBytesSql('payload_json')

const TURN_SHAPE = `AND (kind IN ('message','turn','status') OR turn_scope_kind='unknown')`

// Rows share one reply: past this total, the largest have their tool output or patch cut.
const WINDOW_BYTES = JOURNAL_READER_REPLY_BYTE_LIMIT / 2
const CUT_ROW_BYTES = 64 * 1024
// Only these carry a tool output or patch to cut; any other row comes back as stored.
const CUTTABLE = `kind IN ('tool-call','diff')`

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
  const projected = anchors.withoutToolOutput ? WITHOUT_TOOL_OUTPUT : 'payload_json'
  const projectedStoredText = journalStoredTextBytesSql(projected)
  const rows = `FROM journal_items INDEXED BY journal_items_visible_position
    WHERE session_id=? AND epoch=? AND hidden=0 AND sequence>=? ${anchors.turnShape ? TURN_SHAPE : ''}`
  // Plain sizes cost no parse; only a window past the budget sizes rows as projected.
  const sizes = scope.db
    .prepare(`SELECT item_id, octet_length(payload_json) + ${STORED_TEXT} AS bytes,
      ${CUTTABLE} AS cuttable ${rows}`)
    .all(...scope.prefix, start)
    .map((row) => ({
      itemId: String(row.item_id),
      bytes: Number(row.bytes),
      cuttable: Boolean(row.cuttable),
      diff: false
    }))
  let total = sizes.reduce((sum, row) => sum + row.bytes, 0)
  const large = sizes.filter((row) => row.cuttable && row.bytes > CUT_ROW_BYTES)
  if (total > WINDOW_BYTES && large.length > 0) {
    const measured = new Map(
      scope.db
        .prepare(`SELECT item_id, octet_length(${projected}) + ${projectedStoredText} AS bytes,
          CASE WHEN kind='tool-call' AND json_valid(payload_json)
            AND json_extract(payload_json,'$.body.name') IS 'Diff' THEN 1 ELSE 0 END AS diff
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
  if (total > WINDOW_BYTES && anchors.withoutToolOutput) {
    // Small tool rows were counted whole, but come back without their output; large ones are measured.
    total =
      Number(
        scope.db
          .prepare(`SELECT SUM(CASE WHEN octet_length(payload_json) + ${STORED_TEXT}<=${CUT_ROW_BYTES}
          OR NOT ${CUTTABLE} THEN octet_length(${projected}) + ${projectedStoredText} END) AS bytes ${rows}`)
          .get(...scope.prefix, start)?.bytes ?? 0
      ) + large.reduce((sum, row) => sum + row.bytes, 0)
  }
  // A cut row may keep a large input; the window total, not a per-row bound, admits it.
  // Largest first, Diff calls last: their patch names the files they edited. Each cut is
  // counted at the size it actually comes back at, which is whole when nothing could be cut.
  // A stored row holds at most 32 KiB: it is restored and cut here, to the head SQL gives inline
  // text, and sized at that head.
  const cutJson = shortenedJsonSql(projected, JOURNAL_READER_REPLY_BYTE_LIMIT)
  const cutSize = scope.db.prepare(`SELECT ${projectedStoredText} AS stored,
      CASE WHEN ${projectedStoredText} = 0 THEN octet_length(${cutJson}) END AS cut_bytes
    FROM journal_items WHERE session_id=? AND epoch=? AND item_id=?`)
  // Only a stored row is read whole, and it holds at most 32 KiB of text.
  const storedRow = scope.db.prepare(`SELECT ${projected} AS payload_json, output_blob,
      octet_length(${projected}) AS projected_bytes,
      octet_length(COALESCE(${projected}->'$.body.output', ${projected}->'$.body.patch')) AS text_field_bytes
    FROM journal_items WHERE session_id=? AND epoch=? AND item_id=?`)
  const cut: string[] = []
  const storedCut = new Map<string, AgentJournalRenderItem>()
  for (const row of large.toSorted(
    (a, b) => Number(a.diff) - Number(b.diff) || b.bytes - a.bytes
  )) {
    if (row.bytes > WINDOW_BYTES || (total > WINDOW_BYTES && row.bytes > CUT_ROW_BYTES)) {
      const size = cutSize.get(...scope.prefix, row.itemId)
      let cutBytes = size?.cut_bytes
      const stored =
        Number(size?.stored ?? 0) > 0 ? storedRow.get(...scope.prefix, row.itemId) : null
      if (stored) {
        const read = scope.examined(stored)
        const item = shortenJournalItemHead(
          scope.decode<AgentJournalRenderItem>(read.payload_json, read.output_blob)
        )
        storedCut.set(row.itemId, item)
        cutBytes =
          Number(stored.projected_bytes) -
          Number(stored.text_field_bytes) +
          Buffer.byteLength(JSON.stringify(journalItemTextField(item)))
      } else {
        cut.push(row.itemId)
      }
      if (typeof cutBytes === 'number') {
        total -= row.bytes - cutBytes
        row.bytes = cutBytes
      }
    }
  }
  if (total > JOURNAL_READER_REPLY_BYTE_LIMIT) {
    throw new Error(
      `journal operation window (${total} bytes after cutting) exceeds ${JOURNAL_READER_REPLY_BYTE_LIMIT} bytes`
    )
  }
  const restored = JSON.stringify([...storedCut.keys()])
  // A cut row whose bulk is not its output or patch comes back whole, within the total above.
  const value = `CASE WHEN item_id IN (SELECT value FROM json_each(?)) THEN NULL${
    cut.length
      ? ` WHEN item_id IN (SELECT value FROM json_each(?)) THEN COALESCE(${cutJson}, ${projected})`
      : ''
  } ELSE ${projected} END`
  // Only rows that still carry a stored marker read their blob; a dropped output needs none.
  const blob = `CASE WHEN output_blob IS NULL${anchors.withoutToolOutput ? ` OR (${DROPS_TOOL_OUTPUT})` : ''}
    OR item_id IN (SELECT value FROM json_each(?)) THEN NULL ELSE output_blob END`
  return scope.db
    .prepare(
      `SELECT item_id, ${value} AS payload_json, ${blob} AS output_blob ${rows} ORDER BY sequence,sequence_index,ordinal`
    )
    .all(restored, ...(cut.length ? [JSON.stringify(cut)] : []), restored, ...scope.prefix, start)
    .map((row) => {
      const restoredItem = storedCut.get(String(row.item_id))
      if (restoredItem) {
        return restoredItem
      }
      const read = scope.examined(row)
      return scope.decode<AgentJournalRenderItem>(read.payload_json, read.output_blob)
    })
}

function journalItemTextField(item: AgentJournalRenderItem): unknown {
  const body = item.body as { output?: unknown; patch?: unknown }
  return body.output ?? body.patch
}
