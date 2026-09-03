import type { OrchestrationDb } from '../orchestration-db'

export function applySchemaMigrationV31(this: OrchestrationDb, current: number): void {
  if (current >= 31) {
    return
  }
  this.db.exec(`
    CREATE TABLE IF NOT EXISTS run_collaboration_topologies (
      run_id   TEXT PRIMARY KEY,
      topology TEXT NOT NULL
    );

    CREATE TRIGGER IF NOT EXISTS trg_runs_forget_collaboration_topology
    AFTER DELETE ON runs
    BEGIN
      DELETE FROM run_collaboration_topologies WHERE run_id = OLD.id;
    END;
  `)
}
