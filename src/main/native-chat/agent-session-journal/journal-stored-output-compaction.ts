import type Database from '../../sqlite/sync-database'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { AGENT_SESSION_ITEM_WIRE_VERSION } from '../agent-session-wire/publication/history/agent-session-item-presentation-contract'
import { journalStoredItemRow } from './journal-stored-output-rows'
import { JOURNAL_DOMAIN_ITEM_COLUMNS } from './journal-domain-item-read-columns'
import {
  hydrateJournalItemOutput,
  JOURNAL_STORED_OUTPUT_WRITES,
  MAX_STORED_TEXT_BYTES
} from './journal-stored-output'

/** The last rowid examined; rows appended later are picked up, rows behind it are never rescanned. */
export const JOURNAL_STORED_OUTPUT_CURSOR = 'journal.stored-output.cursor'

// Each page is one writer transaction: bounded rows scanned, rows rewritten, bytes and time.
const SCAN_ROWS = 512
const PAGE_ROWS = 32
const PAGE_BYTES = 512 * 1024
const PAGE_MS = 5
const MIN_ROW_BYTES = 512
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

function compactRow(db: Database.Database, rowid: number, writes: boolean): void {
  const row = db
    .prepare('SELECT session_id, epoch, payload_json, wire_bytes FROM journal_items WHERE rowid=?')
    .get(rowid)!
  const payload = String(row.payload_json)
  const item: AgentJournalRenderItem = JSON.parse(payload)
  const values: (number | null)[] = JOURNAL_DOMAIN_ITEM_COLUMNS.map(() => null)
  values[WIRE_BYTES] = row.wire_bytes === null ? null : Number(row.wire_bytes)
  const prefix = [String(row.session_id), String(row.epoch)] as const
  const stored = journalStoredItemRow(db, prefix, item, payload, values, writes)
  if (!stored.blob) {
    return
  }
  const restored = hydrateJournalItemOutput(JSON.parse(stored.payload), stored.blob)
  if (payloadText(restored) !== payloadText(item)) {
    throw new Error('stored tool output did not read back as written')
  }
  db.prepare(
    'UPDATE journal_items SET payload_json=?, wire_bytes=?, output_blob=? WHERE rowid=?'
  ).run(stored.payload, stored.values[WIRE_BYTES] ?? null, stored.blob, rowid)
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
  // Lengths and NULL tests come from record headers, so skipped rows never load their text. Headers
  // are read lazily: a page cut short by its budget never fetches the rows the next page starts at.
  const headers = db
    .prepare(`SELECT rowid, kind, wire_version, output_blob IS NULL AS inline,
      octet_length(payload_json) AS bytes FROM journal_items WHERE rowid>? ORDER BY rowid LIMIT ?`)
    .iterate(cursor, SCAN_ROWS)
  let scanned = 0
  let rows = 0
  let bytes = 0
  let more = false
  for (const header of headers) {
    const size = Number(header.bytes)
    if (
      rows >= PAGE_ROWS ||
      (rows > 0 && (bytes + size > PAGE_BYTES || performance.now() - started >= PAGE_MS))
    ) {
      more = true
      break
    }
    scanned++
    cursor = Number(header.rowid)
    if (
      (header.kind !== 'tool-call' && header.kind !== 'diff') ||
      header.wire_version !== AGENT_SESSION_ITEM_WIRE_VERSION ||
      !header.inline ||
      size < MIN_ROW_BYTES ||
      // Judged from the record header: a row this large is never loaded inside a page.
      size > MAX_STORED_TEXT_BYTES * 2
    ) {
      continue
    }
    rows++
    bytes += size
    try {
      compactRow(db, cursor, writes)
    } catch (error) {
      // A row that can't be stored exactly stays inline; rethrowing would retry this page forever.
      console.warn('[agent-session-journal] kept a saved tool output inline', error)
    }
  }
  more ||= scanned === SCAN_ROWS
  db.prepare(`INSERT INTO agent_session_store_meta(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(
    JOURNAL_STORED_OUTPUT_CURSOR,
    String(cursor)
  )
  return { kind: 'stored-output-compaction', more }
}
