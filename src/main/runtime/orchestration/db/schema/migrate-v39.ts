import type { OrchestrationDb } from '../orchestration-db'

/**
 * Admits a structured session's journal into the worker archive.
 *
 * A CHECK constraint cannot be widened in place, so the table is rebuilt and copied forward. This
 * is the one part of the structured-session schema that a fresh `createTables` cannot supply to an
 * existing database: `IF NOT EXISTS` leaves an already-created table's narrower CHECK untouched.
 *
 * `structured_pointer_operations` is deliberately not created here — `createTables` runs
 * unconditionally on every open, ahead of migration, and already declares it.
 */
export function migrateV39(this: OrchestrationDb, current: number): void {
  if (current >= 39) {
    return
  }
  this.db.exec(`
      CREATE TABLE IF NOT EXISTS worker_terminal_archives_v39 (
        dispatch_id   TEXT PRIMARY KEY,
        resource_id   TEXT NOT NULL,
        kind          TEXT NOT NULL CHECK(kind IN ('transcript_pin', 'terminal_tail', 'structured_journal')),
        content       TEXT NOT NULL,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT OR REPLACE INTO worker_terminal_archives_v39
        (dispatch_id, resource_id, kind, content, created_at)
        SELECT dispatch_id, resource_id, kind, content, created_at FROM worker_terminal_archives;
      DROP TABLE worker_terminal_archives;
      ALTER TABLE worker_terminal_archives_v39 RENAME TO worker_terminal_archives;
    `)
}
