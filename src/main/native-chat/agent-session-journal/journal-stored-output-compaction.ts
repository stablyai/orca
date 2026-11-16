import type Database from '../../sqlite/sync-database'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { journalStoredItemRow } from './journal-stored-output-rows'
import { JOURNAL_DOMAIN_ITEM_COLUMNS } from './journal-domain-item-read-columns'
import { hydrateJournalItemOutput, JOURNAL_STORED_OUTPUT_WRITES } from './journal-stored-output'

export const JOURNAL_STORED_OUTPUT_CURSOR = 'journal.stored-output.cursor'

// Each page is one writer transaction: bounded rows scanned, rows rewritten, bytes and time.
const SCAN_ROWS = 512
const PAGE_ROWS = 32
const PAGE_BYTES = 512 * 1024
const PAGE_MS = 5
const MIN_ROW_BYTES = 512
const WIRE_JSON = JOURNAL_DOMAIN_ITEM_COLUMNS.indexOf('wire_json')
const WIRE_BYTES = JOURNAL_DOMAIN_ITEM_COLUMNS.indexOf('wire_bytes')

export type JournalStoredOutputCompaction = { kind: 'stored-output-compaction'; more: boolean }

function payloadText(item: AgentJournalRenderItem): string | undefined {
  const body = item.body
  return body.kind === 'tool-call'
    ? body.output?.head
    : body.kind === 'diff'
      ? body.patch.head
      : undefined
}

/** Moves saved tool output and diff text written inline into compressed row blobs, oldest rows first. */
export function compactJournalStoredOutputPage(
  db: Database.Database,
  writes = JOURNAL_STORED_OUTPUT_WRITES
): JournalStoredOutputCompaction {
  if (!writes) {
    return { kind: 'stored-output-compaction', more: false }
  }
  const started = performance.now()
  const saved = db
    .prepare('SELECT value FROM agent_session_store_meta WHERE key=?')
    .get(JOURNAL_STORED_OUTPUT_CURSOR)
  let cursor = saved ? Number(saved.value) : 0
  // Lengths and NULL tests come from record headers, so skipped rows never load their text.
  const scanned = db
    .prepare(`SELECT rowid, kind, output_blob IS NULL AS inline, octet_length(payload_json) AS bytes
      FROM journal_items WHERE rowid>? ORDER BY rowid LIMIT ?`)
    .all(cursor, SCAN_ROWS)
  const read = db.prepare(`SELECT session_id, epoch, payload_json, wire_json, wire_bytes
    FROM journal_items WHERE rowid=?`)
  const update = db.prepare(`UPDATE journal_items SET payload_json=?, wire_json=?, wire_bytes=?,
    output_blob=? WHERE rowid=?`)
  let rows = 0
  let bytes = 0
  let more = scanned.length === SCAN_ROWS
  for (const header of scanned) {
    if (rows >= PAGE_ROWS || (rows > 0 && bytes + Number(header.bytes) > PAGE_BYTES)) {
      more = true
      break
    }
    if (rows > 0 && performance.now() - started >= PAGE_MS) {
      more = true
      break
    }
    cursor = Number(header.rowid)
    if (
      (header.kind !== 'tool-call' && header.kind !== 'diff') ||
      !header.inline ||
      Number(header.bytes) < MIN_ROW_BYTES
    ) {
      continue
    }
    const row = read.get(cursor)!
    const payload = String(row.payload_json)
    const item: AgentJournalRenderItem = JSON.parse(payload)
    const values: (string | number | null)[] = JOURNAL_DOMAIN_ITEM_COLUMNS.map(() => null)
    values[WIRE_JSON] = row.wire_json === null ? null : String(row.wire_json)
    values[WIRE_BYTES] = row.wire_bytes === null ? null : Number(row.wire_bytes)
    const prefix = [String(row.session_id), String(row.epoch)] as const
    const stored = journalStoredItemRow(db, prefix, item, payload, values, writes)
    rows++
    bytes += Number(header.bytes)
    if (!stored.blob) {
      continue
    }
    // A row that would not read back exactly stays inline; throwing would retry this page forever.
    const restored = hydrateJournalItemOutput(JSON.parse(stored.payload), stored.blob)
    if (payloadText(restored) !== payloadText(item)) {
      console.warn('[agent-session-journal] kept a tool output inline that did not read back')
      continue
    }
    update.run(
      stored.payload,
      stored.values[WIRE_JSON] as string | null,
      stored.values[WIRE_BYTES] as number | null,
      stored.blob,
      cursor
    )
  }
  db.prepare(`INSERT INTO agent_session_store_meta(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(
    JOURNAL_STORED_OUTPUT_CURSOR,
    String(cursor)
  )
  return { kind: 'stored-output-compaction', more }
}
