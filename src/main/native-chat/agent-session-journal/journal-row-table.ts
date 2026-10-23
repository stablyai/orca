// Every statement the journal issues against `journal_rows` / `journal_sessions`.
//
// Rows are keyed by the chat's identity: `(session_id, epoch, seq)`, the table's primary key. A
// replay is one range scan of that key, and retiring an epoch deletes one range of it. Columns are
// always named: `SELECT *` is uncacheable and can drop a column.

import type Database from '../../sqlite/sync-database'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import {
  readAgentJournalTurn,
  readAgentJournalTurnOutcome
} from '../../../shared/agent-session-turn-record'
import { parseJournalRow, serializeJournalRow, type JournalRow } from './journal-row-schema'
import { AgentSessionJournalError } from './journal-write-guards'

export type JournalStoredRow = { epoch: string; seq: number; ts: number; rowJson: string }

const SELECT_EPOCH = 'SELECT epoch FROM journal_sessions WHERE session_id = ?'
// A new epoch holds no turn until its own rows open one.
const PUBLISH_SESSION_EPOCH = `INSERT INTO journal_sessions (session_id, workspace_id, epoch)
VALUES (?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET
  workspace_id = excluded.workspace_id, epoch = excluded.epoch,
  open_turn_id = NULL, open_turn_since = NULL`
// A revision of the turn already open keeps when it started.
const OPEN_TURN = `UPDATE journal_sessions SET
  open_turn_since = CASE WHEN open_turn_id IS ? THEN open_turn_since ELSE ? END,
  open_turn_id = ?
WHERE session_id = ?`
const FINISH_TURN = `UPDATE journal_sessions SET open_turn_id = NULL, open_turn_since = NULL
WHERE session_id = ? AND open_turn_id = ?`
const SELECT_REST_FACTS = `SELECT s.open_turn_id AS open_turn_id, s.open_turn_since AS open_turn_since,
  r.seq AS last_seq, r.ts AS last_ts
FROM journal_sessions s
LEFT JOIN journal_rows r ON r.session_id = s.session_id AND r.epoch = s.epoch AND r.seq = (
  SELECT MAX(seq) FROM journal_rows WHERE session_id = s.session_id AND epoch = s.epoch)
WHERE s.session_id = ?`
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

/** What a restart reads of a chat without reading its history: its open root turn, and its newest
 *  row's place and save time. Two primary-key lookups. Null when the chat has no journal. */
export type JournalRestFacts = {
  openTurn: { itemId: string; since: number } | null
  lastSequence: number
  lastSavedAt: number
}

export function readJournalRestFacts(
  db: Database.Database,
  sessionId: string
): JournalRestFacts | null {
  const row = db.prepare(SELECT_REST_FACTS).get(sessionId)
  if (!row) {
    return null
  }
  const { open_turn_id: itemId, open_turn_since: since, last_seq: seq, last_ts: ts } = row
  return {
    openTurn:
      typeof itemId === 'string' ? { itemId, since: typeof since === 'number' ? since : 0 } : null,
    lastSequence: typeof seq === 'number' ? seq : 0,
    lastSavedAt: typeof ts === 'number' ? ts : 0
  }
}

/** Points the chat at `epoch`, with no turn open. Only an epoch change writes this row. */
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
  // The table timestamp records the save; the JSON timestamp can remain pinned to item start.
  db.prepare(INSERT_ROW).run(sessionId, row.epoch, row.seq, savedAt, rowJson)
  recordJournalOpenTurn(db, sessionId, row)
  return Buffer.byteLength(rowJson, 'utf8')
}

/** The chat's open root turn follows the turn records this row writes, in the row's own
 *  transaction, so it can never disagree with the rows. A running record opens its turn; only a
 *  finish the provider reported closes it. One a stop, crash or quit cut short stays open, which is
 *  what a restart reads as interrupted. Rows that write no turn record cost nothing here. */
function recordJournalOpenTurn(db: Database.Database, sessionId: string, row: JournalRow): void {
  const writes =
    row.kind === 'item'
      ? [row]
      : row.kind === 'lifecycle-batch'
        ? row.mutations.flatMap((mutation) => (mutation.kind === 'item' ? [mutation] : []))
        : []
  for (const write of writes) {
    const turn = isRootAgentJournalItem(write) ? readAgentJournalTurn(write.body) : null
    if (turn?.state === 'running') {
      const since = turn.startedAt ?? turn.requestedAt ?? row.ts
      db.prepare(OPEN_TURN).run(write.itemId, since, write.itemId, sessionId)
    } else if (
      turn?.state === 'completed' &&
      readAgentJournalTurnOutcome(turn) !== 'cancellation'
    ) {
      db.prepare(FINISH_TURN).run(sessionId, write.itemId)
    }
  }
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
