// Keyed projection writes preserve insertion order without rewriting unchanged entities.

import type Database from '../../sqlite/sync-database'
import { JOURNAL_STATE_CODEC_VERSION } from './journal-state-codec'

/** journal_state is the cache's one stamp and its per-session anchor: generation 0 marks a cache
 * still being written, and the sweep reaches every cached row through this row. */
export function ensureJournalSavedStateTables(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS journal_state (
    session_id TEXT PRIMARY KEY, epoch TEXT NOT NULL, generation INTEGER NOT NULL,
    through_seq INTEGER NOT NULL, version INTEGER NOT NULL, state_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS journal_items (
    session_id TEXT NOT NULL, epoch TEXT NOT NULL, item_id TEXT NOT NULL,
    ordinal TEXT NOT NULL, item_json TEXT NOT NULL,
    PRIMARY KEY (session_id, epoch, item_id)
  );
  CREATE TABLE IF NOT EXISTS journal_entries (
    session_id TEXT NOT NULL, epoch TEXT NOT NULL, field TEXT NOT NULL,
    entry_key TEXT NOT NULL, ordinal TEXT NOT NULL, entry_json TEXT NOT NULL,
    PRIMARY KEY (session_id, epoch, field, entry_key)
  );
  CREATE INDEX IF NOT EXISTS journal_items_order ON journal_items (session_id, epoch, ordinal);
  CREATE INDEX IF NOT EXISTS journal_entries_order ON journal_entries (session_id, epoch, field, ordinal)`)
}

/** Stamps the cache complete for `generation` through `through`; generation 0 leaves it unstamped. */
export function writeJournalProjectionScalars(
  db: Database.Database,
  stamp: {
    sessionId: string
    epoch: string
    generation: number
    through: number
    stateJson: string
  }
): void {
  db.prepare(`INSERT INTO journal_state
    (session_id, epoch, generation, through_seq, version, state_json)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET
    epoch = excluded.epoch, generation = excluded.generation, through_seq = excluded.through_seq,
    version = excluded.version, state_json = excluded.state_json`).run(
    stamp.sessionId,
    stamp.epoch,
    stamp.generation,
    stamp.through,
    JOURNAL_STATE_CODEC_VERSION,
    stamp.stateJson
  )
}

/** Epoch publishers call this inside their row/epoch transaction. */
export function clearJournalSavedState(db: Database.Database, sessionId: string): void {
  for (const table of ['journal_items', 'journal_entries', 'journal_state']) {
    db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId)
  }
}
