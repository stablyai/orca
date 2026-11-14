import { randomUUID } from 'node:crypto'
import type { JournalHostDatabase } from './journal-host-database'
import type Database from '../../../sqlite/sync-database'
import { readJournalSessionEpoch } from '../durable-rows/journal-row-table'
import { journalOutcomeSource } from '../outcomes/journal-outcome-format'
export type Position = { seq: number; field: string; key: string }
export type Source = {
  sessionId: string
  epoch: string
  generation: number
  fingerprint: string
  through: number
}
export type Coverage = Position & { incarnation: string; dirty: number; fingerprint: string }
export type Page = {
  id: number
  failed?: boolean
  after: Position
  complete: boolean
  locators: (Position & { kind: number })[]
}
export type Demand = {
  source: Source
  resolve: (ready: boolean) => void
  signal?: AbortSignal
}
export const HISTORY_DECODER = 2

export function ensureJournalHistoryTables(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS journal_history_coverage (
        session_id TEXT NOT NULL, epoch TEXT NOT NULL, generation INTEGER NOT NULL,
        decoder INTEGER NOT NULL, fingerprint TEXT NOT NULL, incarnation TEXT NOT NULL,
        seq INTEGER NOT NULL, field TEXT NOT NULL, entry_key TEXT NOT NULL, dirty INTEGER NOT NULL,
        PRIMARY KEY(session_id, epoch, generation)
      );
      CREATE TABLE IF NOT EXISTS journal_history_locators (
        session_id TEXT NOT NULL, epoch TEXT NOT NULL, generation INTEGER NOT NULL,
        seq INTEGER NOT NULL, field TEXT NOT NULL, entry_key TEXT NOT NULL, kind INTEGER NOT NULL,
        incarnation TEXT NOT NULL,
        PRIMARY KEY(session_id, epoch, generation, seq, field, entry_key)
      );
      CREATE INDEX IF NOT EXISTS journal_history_kinds ON journal_history_locators
        (session_id, epoch, generation, kind, seq);
      CREATE INDEX IF NOT EXISTS journal_history_generations ON journal_history_coverage (generation);
      CREATE TRIGGER IF NOT EXISTS journal_history_raw_update AFTER UPDATE ON journal_rows
      BEGIN UPDATE journal_history_coverage SET dirty = 1
        WHERE session_id = OLD.session_id AND epoch = OLD.epoch AND generation = 0 AND dirty = 0; END;
      CREATE TRIGGER IF NOT EXISTS journal_history_raw_delete AFTER DELETE ON journal_rows
      BEGIN UPDATE journal_history_coverage SET dirty = 1
        WHERE session_id = OLD.session_id AND epoch = OLD.epoch AND generation = 0 AND dirty = 0; END;
      CREATE TRIGGER IF NOT EXISTS journal_history_outcome_update AFTER UPDATE ON journal_outcomes
      BEGIN UPDATE journal_history_coverage SET dirty = 1
        WHERE generation = OLD.generation AND dirty = 0; END;
      CREATE TRIGGER IF NOT EXISTS journal_history_outcome_delete AFTER DELETE ON journal_outcomes
      BEGIN UPDATE journal_history_coverage SET dirty = 1
        WHERE generation = OLD.generation AND dirty = 0; END;`)
}

export function historySourceState(db: Database.Database, sessionId: string) {
  const epoch = readJournalSessionEpoch(db, sessionId)
  if (!epoch) {
    return { epoch, outcome: null, rawThrough: 0, sources: [] }
  }
  const source = journalOutcomeSource(db, sessionId, epoch)
  const raw = {
    sessionId,
    epoch,
    generation: 0,
    fingerprint: 'raw',
    through:
      source?.prefix ??
      Number(
        db
          .prepare(`SELECT MAX(seq) AS seq FROM journal_rows
        WHERE session_id = ? AND epoch = ?`)
          .get(sessionId, epoch)?.seq ?? 0
      )
  }
  const sources: Source[] = [
    raw,
    ...(source
      ? [
          {
            sessionId,
            epoch,
            generation: source.generation,
            fingerprint: `${source.prefix}:${source.marker}:${source.format}`,
            through: source.through
          }
        ]
      : [])
  ]
  return { epoch, outcome: source, rawThrough: raw.through, sources }
}

export function historySources(db: Database.Database, sessionId: string): Source[] {
  return historySourceState(db, sessionId).sources
}

export function historyCoverage(db: Database.Database, source: Source): Coverage | undefined {
  const row = db
    .prepare(`SELECT seq, field, entry_key, incarnation, dirty FROM journal_history_coverage
      WHERE session_id = ? AND epoch = ? AND generation = ? AND decoder = ? AND fingerprint = ?`)
    .get(source.sessionId, source.epoch, source.generation, HISTORY_DECODER, source.fingerprint)
  return row
    ? {
        seq: Number(row.seq),
        field: String(row.field),
        key: String(row.entry_key),
        incarnation: String(row.incarnation),
        dirty: Number(row.dirty),
        fingerprint: source.fingerprint
      }
    : undefined
}

export function historySourceKey(source: Source): string {
  return JSON.stringify([source.sessionId, source.epoch, source.generation, source.fingerprint])
}

const END = '\uffff'

export function historyCovers(source: Source, position: Position, through: number): boolean {
  return (
    position.seq > through ||
    (position.seq === through &&
      (source.generation === 0 || (position.field === END && position.key === END)))
  )
}

export function ensureHistoryCoverage(database: JournalHostDatabase, source: Source): Coverage {
  const saved = historyCoverage(database.db, source)
  if (saved && saved.dirty === 0) {
    return saved
  }
  const initialize = (db: Database.Database) => {
    const current = historySources(db, source.sessionId).find(
      (value) => historySourceKey(value) === historySourceKey(source)
    )
    if (!current || current.through < source.through) {
      throw new Error('history source changed')
    }
    db.prepare(
      `INSERT OR REPLACE INTO journal_history_coverage VALUES (?, ?, ?, ?, ?, ?, 0, '', '', 0)`
    ).run(
      source.sessionId,
      source.epoch,
      source.generation,
      HISTORY_DECODER,
      source.fingerprint,
      randomUUID()
    )
  }
  if (database.db.isTransaction) {
    initialize(database.db)
  } else {
    database.transaction(initialize)
  }
  return historyCoverage(database.db, source)!
}
