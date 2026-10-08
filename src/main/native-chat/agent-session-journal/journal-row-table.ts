// Every statement the journal issues against `journal_rows` / `journal_sessions`.
//
// Rows are keyed by the chat's identity: `(session_id, epoch, seq)`, the table's primary key. A
// replay is one range scan of that key, and retiring an epoch deletes one range of it. Columns are
// always named: `SELECT *` is uncacheable and can drop a column.

import type Database from '../../sqlite/sync-database'
import { parseJournalRow, serializeJournalRow, type JournalRow } from './journal-row-schema'
import { AgentSessionJournalError } from './journal-write-guards'

export type JournalStoredRow = { epoch: string; seq: number; ts: number; rowJson: string }

const SELECT_EPOCH = 'SELECT epoch FROM journal_sessions WHERE session_id = ?'
const PUBLISH_SESSION_EPOCH = `INSERT INTO journal_sessions (session_id, workspace_id, epoch)
VALUES (?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET
  workspace_id = excluded.workspace_id, epoch = excluded.epoch`
const INSERT_ROW =
  'INSERT INTO journal_rows (session_id, epoch, seq, ts, row_json) VALUES (?, ?, ?, ?, ?)'
const SELECT_ROWS_AFTER = `SELECT seq, ts, row_json FROM journal_rows
WHERE session_id = ? AND epoch = ? AND seq > ? ORDER BY seq ASC`
const SELECT_ROWS_AFTER_LIMITED = `${SELECT_ROWS_AFTER} LIMIT ?`
const DELETE_EPOCH = 'DELETE FROM journal_rows WHERE session_id = ? AND epoch = ?'

export function readJournalSessionEpoch(db: Database.Database, sessionId: string): string | null {
  const epoch = db.prepare(SELECT_EPOCH).get(sessionId)?.epoch
  return typeof epoch === 'string' ? epoch : null
}

/** Points the chat at `epoch`. Only an epoch change writes this row. */
export function publishJournalSessionEpoch(
  db: Database.Database,
  identity: { sessionId: string; workspaceId: string },
  epoch: string
): void {
  db.prepare(PUBLISH_SESSION_EPOCH).run(identity.sessionId, identity.workspaceId, epoch)
}

export function insertJournalRow(
  db: Database.Database,
  sessionId: string,
  row: JournalRow
): number {
  const rowJson = serializeJournalRow(row)
  // A row the reader rejects would fail the chat's next load, so it is never written: the throw
  // rolls back the caller's transaction.
  const readBack = parseJournalRow(rowJson)
  if (!readBack.ok || readBack.row.seq !== row.seq) {
    throw new AgentSessionJournalError(
      'journal_row_rejected',
      `the ${row.kind} row for ${sessionId} would not read back, so it was not written`
    )
  }
  db.prepare(INSERT_ROW).run(sessionId, row.epoch, row.seq, row.ts, rowJson)
  return Buffer.byteLength(rowJson, 'utf8')
}

// Why pages, not `.iterate()`: a lazily consumed cursor pins a read snapshot for as long as the
// consumer reduces, and a WAL checkpoint cannot pass an open snapshot. Each page is one completed
// statement, so the consumer's memory is bounded by a page while no snapshot outlives a fetch.
const EPOCH_ROW_PAGE_SIZE = 128

/** The epoch's rows in sequence order, fetched one completed statement at a time. */
export function* iterateJournalEpochRows(
  db: Database.Database,
  sessionId: string,
  epoch: string
): Generator<JournalStoredRow> {
  let afterSeq = Number.MIN_SAFE_INTEGER
  for (;;) {
    const page = readJournalRowsAfter(db, sessionId, epoch, afterSeq, EPOCH_ROW_PAGE_SIZE)
    yield* page
    const last = page.at(-1)
    if (page.length < EPOCH_ROW_PAGE_SIZE || last === undefined) {
      return
    }
    afterSeq = last.seq
  }
}

export function readJournalRowsAfter(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  afterSeq: number,
  limit?: number
): JournalStoredRow[] {
  const rows =
    limit !== undefined
      ? db.prepare(SELECT_ROWS_AFTER_LIMITED).all(sessionId, epoch, afterSeq, limit)
      : db.prepare(SELECT_ROWS_AFTER).all(sessionId, epoch, afterSeq)
  return rows.flatMap((row) =>
    typeof row.seq === 'number' && typeof row.ts === 'number' && typeof row.row_json === 'string'
      ? [{ epoch, seq: row.seq, ts: row.ts, rowJson: row.row_json }]
      : []
  )
}

/** Every row of a retired epoch, in the transaction that retires it. */
export function deleteJournalEpochRows(
  db: Database.Database,
  sessionId: string,
  epoch: string
): void {
  db.prepare(DELETE_EPOCH).run(sessionId, epoch)
}
