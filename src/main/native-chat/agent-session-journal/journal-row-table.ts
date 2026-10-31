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
  row: JournalRow,
  savedAt = row.ts
): number {
  const { rowJson } = journalRowReadBack(sessionId, row)
  // The table timestamp records the save; the JSON timestamp can remain pinned to item start.
  db.prepare(INSERT_ROW).run(sessionId, row.epoch, row.seq, savedAt, rowJson)
  return Buffer.byteLength(rowJson, 'utf8')
}

/** Rejects a row the reader would not read back before it can break the next load, and returns the
 * row the reader sees: without the annotations it drops as unusable. */
export function journalRowReadBack(
  sessionId: string,
  row: JournalRow
): { rowJson: string; stored: JournalRow } {
  const rowJson = serializeJournalRow(row)
  const readBack = parseJournalRow(rowJson)
  if (!readBack.ok || readBack.row.seq !== row.seq) {
    throw new AgentSessionJournalError(
      'journal_row_rejected',
      `the ${row.kind} row for ${sessionId} would not read back, so it was not written`
    )
  }
  return { rowJson, stored: readBack.row }
}

// Page fetches release read snapshots before reduction so WAL checkpoints are not blocked.
const EPOCH_ROW_PAGE_SIZE = 128

export function* iterateJournalEpochRows(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  afterSequence = Number.MIN_SAFE_INTEGER
): Generator<JournalStoredRow> {
  let afterSeq = afterSequence
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

export function deleteJournalEpochRows(
  db: Database.Database,
  sessionId: string,
  epoch: string
): void {
  db.prepare(DELETE_EPOCH).run(sessionId, epoch)
}
