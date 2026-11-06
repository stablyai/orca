import { createHash } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import type { JournalWriterTarget } from './journal-writer-command'
import { AgentSessionJournalError } from './journal-write-guards'
import { readJournalSessionEpoch } from './journal-row-table'

/** Bumped whenever a projection table's meaning changes; a different version reconverts. */
export const JOURNAL_SQL_PROJECTION_VERSION = 1

export function journalSqlMetaSchema(): string {
  return `CREATE TABLE IF NOT EXISTS journal_proj_meta (
    session_id TEXT PRIMARY KEY,
    epoch TEXT NOT NULL,
    generation TEXT NOT NULL,
    through_seq INTEGER NOT NULL,
    owner_token TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    outcome_generation INTEGER,
    rows_through INTEGER NOT NULL,
    legacy_queue TEXT NOT NULL
  ) WITHOUT ROWID;`
}

/** What the saved log covers now; a projection is current only while it records the same. */
export type JournalLogWatermark = {
  epoch: string
  outcomeGeneration: number | null
  through: number
  rowsThrough: number
  legacyQueue: string
}

/** Point reads only: the epoch row, the outcome source row, one index seek and the legacy cards. */
export function readJournalLogWatermark(
  db: Database.Database,
  sessionId: string
): JournalLogWatermark | null {
  const epoch = readJournalSessionEpoch(db, sessionId)
  if (epoch === null) {
    return null
  }
  const source = db
    .prepare(`SELECT generation, through_seq FROM journal_outcome_epochs
    WHERE session_id=? AND epoch=?`)
    .get(sessionId, epoch)
  const rowsThrough = Number(
    db
      .prepare('SELECT MAX(seq) AS seq FROM journal_rows WHERE session_id=? AND epoch=?')
      .get(sessionId, epoch)?.seq ?? 0
  )
  return {
    epoch,
    outcomeGeneration: source ? Number(source.generation) : null,
    through: source ? Number(source.through_seq) : rowsThrough,
    rowsThrough,
    legacyQueue: legacyQueueMarker(db, sessionId)
  }
}

/** Older builds delete legacy cards without a journal row, so their contents are part of coverage. */
function legacyQueueMarker(db: Database.Database, sessionId: string): string {
  const rows = db
    .prepare(`SELECT message_id, position, state, hold_reason, settled_at, consumed_as
    FROM queued_messages WHERE session_id=? ORDER BY message_id`)
    .all(sessionId)
  return rows.length === 0 ? '' : createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}

/** The ready generation whose recorded coverage equals the log's, or null when it must convert. */
export function currentJournalSqlGeneration(
  db: Database.Database,
  sessionId: string
): string | null {
  const log = readJournalLogWatermark(db, sessionId)
  const meta = db.prepare('SELECT * FROM journal_proj_meta WHERE session_id=?').get(sessionId)
  if (!log || !meta || typeof meta.generation !== 'string') {
    return null
  }
  const current =
    meta.schema_version === JOURNAL_SQL_PROJECTION_VERSION &&
    meta.epoch === log.epoch &&
    (meta.outcome_generation ?? null) === log.outcomeGeneration &&
    meta.through_seq === log.through &&
    meta.rows_through === log.rowsThrough &&
    meta.legacy_queue === log.legacyQueue
  return current ? meta.generation : null
}

/** Every log-writing transaction records the whole watermark before it commits. */
export function recordJournalSqlWatermark(db: Database.Database, sessionId: string): void {
  const log = readJournalLogWatermark(db, sessionId)
  if (!log) {
    throw new Error('journal projection has no saved epoch to cover')
  }
  db.prepare(`UPDATE journal_proj_meta SET schema_version=?, epoch=?, outcome_generation=?,
    through_seq=?, rows_through=?, legacy_queue=? WHERE session_id=?`).run(
    JOURNAL_SQL_PROJECTION_VERSION,
    log.epoch,
    log.outcomeGeneration,
    log.through,
    log.rowsThrough,
    log.legacyQueue,
    sessionId
  )
}

/** Publishes a generation that covers the log as it stands in this transaction. */
export function publishJournalSqlGeneration(
  db: Database.Database,
  sessionId: string,
  generation: string,
  ownerToken: string
): void {
  db.prepare(`INSERT INTO journal_proj_meta (session_id, epoch, generation, through_seq,
    owner_token, schema_version, outcome_generation, rows_through, legacy_queue)
    VALUES (?, '', ?, 0, ?, 0, NULL, 0, '')
    ON CONFLICT(session_id) DO UPDATE SET generation=excluded.generation,
    owner_token=excluded.owner_token`).run(sessionId, generation, ownerToken)
  recordJournalSqlWatermark(db, sessionId)
}

/** The chat's projection is missing or no longer covers its log; it converts before it opens. */
export class JournalProjectionStaleError extends Error {
  override readonly name = 'JournalProjectionStaleError'
}

/** An open takes the current generation for its handle; any other open's commands then refuse. */
export function claimJournalSqlProjection(db: Database.Database, target: JournalWriterTarget) {
  const generation = currentJournalSqlGeneration(db, target.sessionId)
  const changed =
    generation === null
      ? 0
      : db
          .prepare('UPDATE journal_proj_meta SET owner_token=? WHERE session_id=? AND epoch=?')
          .run(target.ownerToken, target.sessionId, target.epoch).changes
  if (changed === 0) {
    throw new JournalProjectionStaleError(`chat ${target.sessionId} needs conversion before open`)
  }
}

/** Ownership and epoch are checked again within every command's transaction. */
export function readJournalSqlMeta(db: Database.Database, target: JournalWriterTarget) {
  const row = db
    .prepare(`SELECT p.generation, p.through_seq FROM journal_proj_meta p
    JOIN journal_sessions s ON s.session_id=p.session_id AND s.epoch=p.epoch
    WHERE p.session_id=? AND p.epoch=? AND p.owner_token=?`)
    .get(target.sessionId, target.epoch, target.ownerToken)
  if (typeof row?.generation !== 'string' || typeof row.through_seq !== 'number') {
    throw new AgentSessionJournalError(
      'journal_closed',
      'the chat projection is no longer owned by this handle'
    )
  }
  return { generation: row.generation, through: row.through_seq }
}
