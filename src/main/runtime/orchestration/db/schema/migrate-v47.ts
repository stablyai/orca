import type { OrchestrationDb } from '../orchestration-db'

/** A Run's coordinator may be a paired runtime client outside any terminal, named by its caller fingerprint. */
export function migrateV47(this: OrchestrationDb, current: number): void {
  if (current >= 47) {
    return
  }
  if (!this.hasColumn('runs', 'coordinator_client_fingerprint')) {
    this.db.exec('ALTER TABLE runs ADD COLUMN coordinator_client_fingerprint TEXT')
  }
  this.db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runs_coordinator_client_fingerprint
      ON runs(coordinator_client_fingerprint) WHERE coordinator_client_fingerprint IS NOT NULL;
  `)
}
