import type Database from '../../sqlite/sync-database'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import { readJournalSessionEpoch } from './journal-row-table'
import { AgentSessionJournalError } from './journal-write-guards'
import { JOURNAL_OUTCOME_FORMAT_1 } from './journal-outcome-format-1'
import { JournalOutcomeDecodeError } from './journal-outcome-codec'

// This versions stored meaning, independently of reducer implementation and cache codecs.
export const JOURNAL_OUTCOME_FORMAT = JOURNAL_OUTCOME_FORMAT_1
export const JOURNAL_OUTCOME_SENTINEL_VERSION = 5
/** A generation is its attempt's id: outcome rows carry it instead of session, epoch and a UUID. */
export type JournalOutcomeSource = { generation: number; through: number; format: number }

export function ensureJournalOutcomeTables(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS journal_outcome_attempts (
    generation INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, epoch TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS journal_outcome_attempts_epoch
    ON journal_outcome_attempts (session_id, epoch);
  CREATE TABLE IF NOT EXISTS journal_outcome_epochs (
    session_id TEXT PRIMARY KEY, epoch TEXT NOT NULL, generation INTEGER NOT NULL,
    format INTEGER NOT NULL, through_seq INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS journal_outcomes (
    generation INTEGER NOT NULL, seq INTEGER NOT NULL, field TEXT NOT NULL,
    entry_key TEXT NOT NULL, ordinal TEXT NOT NULL, value_json TEXT NOT NULL,
    deleted INTEGER NOT NULL, PRIMARY KEY (generation, seq, field, entry_key)
  );
  CREATE INDEX IF NOT EXISTS journal_outcome_keys ON journal_outcomes
    (generation, field, entry_key, seq DESC)`)
}

/** Mints the attempt whose id names its outcome generation. */
export function startJournalOutcomeGeneration(
  db: Database.Database,
  sessionId: string,
  epoch: string
): number {
  return Number(
    db
      .prepare('INSERT INTO journal_outcome_attempts (session_id, epoch) VALUES (?, ?)')
      .run(sessionId, epoch).lastInsertRowid
  )
}

/** Every owning mutation calls this inside its transaction, before changing the epoch. */
export function journalOutcomeSource(
  db: Database.Database,
  sessionId: string,
  epoch: string
): JournalOutcomeSource | null {
  if (readJournalSessionEpoch(db, sessionId) !== epoch) {
    throw new AgentSessionJournalError('journal_row_rejected', 'the chat epoch changed')
  }
  const source = db
    .prepare(
      `SELECT generation, format, through_seq FROM journal_outcome_epochs
    WHERE session_id = ? AND epoch = ?`
    )
    .get(sessionId, epoch)
  const founding = readFoundingRow(db, sessionId, epoch)
  if (founding === 'unparseable') {
    // An input epoch's unreadable first row is damage the row fold reports while it keeps looking
    // for newer rows, as main does; a published fence row that is unreadable is outcome damage.
    if (source) {
      throw new JournalOutcomeDecodeError('unreadable journal outcome fence')
    }
    return null
  }
  const marked = typeof founding === 'object' && founding !== null && 'outcomeFormat' in founding
  if (!source && !marked) {
    if (
      typeof founding === 'object' &&
      founding !== null &&
      'v' in founding &&
      typeof founding.v === 'number' &&
      founding.v > AGENT_SESSION_JOURNAL_SCHEMA_VERSION
    ) {
      throw new AgentSessionJournalError('journal_read_only', 'the chat uses a newer row format')
    }
    return null
  }
  if (
    !source ||
    typeof source.generation !== 'number' ||
    source.format !== JOURNAL_OUTCOME_FORMAT ||
    typeof source.through_seq !== 'number' ||
    !marked ||
    !('v' in founding) ||
    founding.v !== JOURNAL_OUTCOME_SENTINEL_VERSION ||
    founding.outcomeFormat !== source.format
  ) {
    throw new AgentSessionJournalError(
      'journal_read_only',
      'the chat uses an unsupported outcome format'
    )
  }
  return { generation: source.generation, format: source.format, through: source.through_seq }
}

function readFoundingRow(db: Database.Database, sessionId: string, epoch: string): unknown {
  const anchor = db
    .prepare(
      `SELECT row_json FROM journal_rows
    WHERE session_id = ? AND epoch = ? AND seq = 1`
    )
    .get(sessionId, epoch)
  if (typeof anchor?.row_json !== 'string') {
    return null
  }
  try {
    return JSON.parse(anchor.row_json)
  } catch {
    return 'unparseable'
  }
}

export function publishJournalOutcomeSource(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  generation: number,
  through: number
): void {
  const row = db
    .prepare(
      `SELECT row_json FROM journal_rows
    WHERE session_id = ? AND epoch = ? AND seq = 1`
    )
    .get(sessionId, epoch)
  if (typeof row?.row_json !== 'string') {
    throw new Error('missing founding journal row')
  }
  const founding: unknown = JSON.parse(row.row_json)
  if (typeof founding !== 'object' || founding === null) {
    throw new Error('invalid founding journal row')
  }
  db.prepare(
    `UPDATE journal_rows SET row_json = ?
    WHERE session_id = ? AND epoch = ? AND seq = 1`
  ).run(
    JSON.stringify({
      ...founding,
      v: JOURNAL_OUTCOME_SENTINEL_VERSION,
      outcomeFormat: JOURNAL_OUTCOME_FORMAT
    }),
    sessionId,
    epoch
  )
  db.prepare(
    `INSERT INTO journal_outcome_epochs VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET epoch = excluded.epoch,
    generation = excluded.generation, format = excluded.format, through_seq = excluded.through_seq`
  ).run(sessionId, epoch, generation, JOURNAL_OUTCOME_FORMAT, through)
}
