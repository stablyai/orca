// Keyed projection writes preserve insertion order without rewriting unchanged entities.

import type Database from '../../sqlite/sync-database'
import type { JournalReducerState } from './journal-reducer'
import { JOURNAL_STATE_CODEC_VERSION } from './journal-state-codec'
import { journalStateScalars } from './journal-state-layout'

export function ensureJournalSavedStateTables(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS journal_state (
    session_id TEXT PRIMARY KEY, epoch TEXT NOT NULL, through_seq INTEGER NOT NULL,
    version INTEGER NOT NULL, state_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS journal_items (
    session_id TEXT NOT NULL, epoch TEXT NOT NULL, item_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL, item_json TEXT NOT NULL,
    PRIMARY KEY (session_id, epoch, item_id)
  );
  CREATE TABLE IF NOT EXISTS journal_entries (
    session_id TEXT NOT NULL, epoch TEXT NOT NULL, field TEXT NOT NULL,
    entry_key TEXT NOT NULL, ordinal INTEGER NOT NULL, entry_json TEXT NOT NULL,
    PRIMARY KEY (session_id, epoch, field, entry_key)
  );
  CREATE INDEX IF NOT EXISTS journal_items_order ON journal_items (session_id, epoch, ordinal);
  CREATE INDEX IF NOT EXISTS journal_entries_order ON journal_entries (session_id, epoch, field, ordinal)`)
}

export function writeJournalProjectionScalars(db: Database.Database, state: JournalReducerState): void {
  db.prepare(`INSERT INTO journal_state (session_id, epoch, through_seq, version, state_json)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET
    epoch = excluded.epoch, through_seq = excluded.through_seq,
    version = excluded.version, state_json = excluded.state_json`).run(
    state.sessionId,
    state.epoch,
    state.lastSequence,
    JOURNAL_STATE_CODEC_VERSION,
    journalStateScalars(state)
  )
}

/** Epoch publishers call this inside their row/epoch transaction. */
export function clearJournalSavedState(db: Database.Database, sessionId: string): void {
  for (const table of ['journal_items', 'journal_entries', 'journal_state', 'journal_cache_stamp']) {
    db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId)
  }
}
