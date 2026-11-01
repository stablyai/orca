import type Database from '../../sqlite/sync-database'
import { readJournalSessionEpoch } from './journal-row-table'
import { AgentSessionJournalError } from './journal-write-guards'
import { JOURNAL_OUTCOME_FORMAT_2 } from './journal-outcome-format-2'
import { JournalOutcomeDecodeError } from './journal-outcome-codec'

/** The newest record format this build reads, and the one it writes. Each stored record carries its
 * own format; older formats keep their frozen decoders and are never rewritten. */
export const JOURNAL_OUTCOME_FORMAT = JOURNAL_OUTCOME_FORMAT_2
/** Builds before outcome records refuse a row of this version wherever it sits in the epoch.
 * Under this version, how the input rows before the marker fold into keys and values is frozen: the
 * tail's records were written over that reading. A build that reads old rows into different keys or
 * values must key the new reading off a new marker version; a prefix key read twice under two
 * names, or a key the tail deleted coming back, is never intended behavior. */
export const JOURNAL_OUTCOME_MARKER_VERSION = 5
/** `prefix` counts the epoch's frozen input rows; the marker row sits right after them and outcome
 * records start at its sequence. `format` is the highest record format the epoch holds. */
export type JournalOutcomeSource = {
  generation: number
  through: number
  format: number
  prefix: number
}

export function ensureJournalOutcomeTables(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS journal_outcome_generations (
    generation INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, epoch TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS journal_outcome_epochs (
    session_id TEXT PRIMARY KEY, epoch TEXT NOT NULL, generation INTEGER NOT NULL,
    format INTEGER NOT NULL, through_seq INTEGER NOT NULL, prefix_seq INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS journal_outcomes (
    generation INTEGER NOT NULL, seq INTEGER NOT NULL, field TEXT NOT NULL,
    entry_key TEXT NOT NULL, format INTEGER NOT NULL, ordinal TEXT NOT NULL,
    value_json TEXT NOT NULL, deleted INTEGER NOT NULL,
    PRIMARY KEY (generation, seq, field, entry_key)
  );
  CREATE INDEX IF NOT EXISTS journal_outcome_keys ON journal_outcomes
    (generation, field, entry_key, seq DESC)`)
}

/** Every owning mutation calls this inside its transaction, before changing the epoch. Null means
 * an input-only epoch, read as main reads it; a format this build does not know refuses as newer. */
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
      `SELECT generation, format, through_seq, prefix_seq FROM journal_outcome_epochs
    WHERE session_id = ? AND epoch = ?`
    )
    .get(sessionId, epoch)
  if (!source) {
    return null
  }
  const { generation, format, through_seq: through, prefix_seq: prefix } = source
  if (
    typeof generation !== 'number' ||
    typeof format !== 'number' ||
    typeof through !== 'number' ||
    typeof prefix !== 'number'
  ) {
    throw new JournalOutcomeDecodeError('invalid journal outcome source')
  }
  if (format > JOURNAL_OUTCOME_FORMAT) {
    throw new AgentSessionJournalError('journal_read_only', 'the chat uses a newer outcome format')
  }
  // Only the marker follows the prefix: a row after it is no row this build writes.
  const [marker, after] = db
    .prepare(`SELECT seq, row_json FROM journal_rows WHERE session_id = ? AND epoch = ? AND seq > ?
      ORDER BY seq LIMIT 2`)
    .all(sessionId, epoch, prefix)
  if (after) {
    throw new AgentSessionJournalError('journal_read_only', 'the chat holds a newer row')
  }
  const version = marker?.seq === prefix + 1 ? markerVersion(marker.row_json) : null
  if (typeof version === 'number' && version > JOURNAL_OUTCOME_MARKER_VERSION) {
    throw new AgentSessionJournalError('journal_read_only', 'the chat uses a newer marker')
  }
  if (version !== JOURNAL_OUTCOME_MARKER_VERSION) {
    throw new JournalOutcomeDecodeError('missing journal outcome marker')
  }
  return { generation, format, through, prefix }
}

function markerVersion(json: unknown): unknown {
  try {
    const parsed: unknown = typeof json === 'string' ? JSON.parse(json) : null
    return typeof parsed === 'object' && parsed !== null && 'v' in parsed ? parsed.v : null
  } catch {
    return null
  }
}

/** Starts an epoch's outcome records after `prefix` input rows, which stay byte for byte. The marker
 * is appended, never written over an existing row, in the transaction of the first outcome. */
export function startJournalOutcomeLog(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  prefix: number,
  savedAt: number
): JournalOutcomeSource {
  const tip = db
    .prepare('SELECT MAX(seq) AS seq FROM journal_rows WHERE session_id = ? AND epoch = ?')
    .get(sessionId, epoch)
  if ((tip?.seq ?? 0) !== prefix) {
    throw new Error('journal outcome log would not start at the input tip')
  }
  const generation = Number(
    db
      .prepare('INSERT INTO journal_outcome_generations (session_id, epoch) VALUES (?, ?)')
      .run(sessionId, epoch).lastInsertRowid
  )
  const seq = prefix + 1
  db.prepare(
    'INSERT INTO journal_rows (session_id, epoch, seq, ts, row_json) VALUES (?, ?, ?, ?, ?)'
  ).run(
    sessionId,
    epoch,
    seq,
    savedAt,
    JSON.stringify({ v: JOURNAL_OUTCOME_MARKER_VERSION, kind: 'outcomes', epoch, seq, ts: savedAt })
  )
  db.prepare(
    `INSERT INTO journal_outcome_epochs VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET epoch = excluded.epoch, generation = excluded.generation,
    format = excluded.format, through_seq = excluded.through_seq, prefix_seq = excluded.prefix_seq`
  ).run(sessionId, epoch, generation, JOURNAL_OUTCOME_FORMAT, prefix, prefix)
  return { generation, format: JOURNAL_OUTCOME_FORMAT, through: prefix, prefix }
}

/** Coverage advances with each write; the required format only ever rises. */
export function advanceJournalOutcomeSource(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  through: number
): void {
  db.prepare(`UPDATE journal_outcome_epochs SET through_seq = ?, format = MAX(format, ?)
    WHERE session_id = ? AND epoch = ?`).run(through, JOURNAL_OUTCOME_FORMAT, sessionId, epoch)
}
