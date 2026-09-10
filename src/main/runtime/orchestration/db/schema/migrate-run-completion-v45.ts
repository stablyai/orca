import type { OrchestrationDb } from '../orchestration-db'

export function applySchemaMigrationV45(this: OrchestrationDb, current: number): void {
  if (current >= 45) {
    return
  }
  this.db.exec(`
    CREATE TABLE IF NOT EXISTS run_completions (
      run_id                  TEXT PRIMARY KEY,
      summary                 TEXT NOT NULL,
      evidence_json           TEXT NOT NULL,
      waivers_json            TEXT NOT NULL DEFAULT '[]',
      completed_by_handle     TEXT NOT NULL,
      completed_by_pane_key   TEXT NOT NULL,
      completed_by_generation INTEGER NOT NULL,
      completed_at            TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS trg_runs_forget_completion
    AFTER DELETE ON runs
    BEGIN
      DELETE FROM run_completions WHERE run_id = OLD.id;
    END;
  `)
}
