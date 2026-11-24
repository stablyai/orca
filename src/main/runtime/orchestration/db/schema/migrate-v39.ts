import type { OrchestrationDb } from '../orchestration-db'

/** Rebuild the archive CHECK for structured journals; createTables cannot widen it and already supplies pointer operations. */
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
