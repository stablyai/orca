import type { OrchestrationDb } from '../orchestration-db'

/** Settled workers' automatic release deadline; rows settled before this step keep none. */
export function migrateV44(this: OrchestrationDb, current: number): void {
  if (current >= 44) {
    return
  }
  for (const column of ['auto_release_at', 'auto_release_dispatch_id']) {
    if (!this.hasColumn('worker_terminal_resources', column)) {
      this.db.exec(`ALTER TABLE worker_terminal_resources ADD COLUMN ${column} TEXT`)
    }
  }
  this.db.exec(`
    CREATE INDEX IF NOT EXISTS idx_worker_terminal_resources_auto_release
      ON worker_terminal_resources(auto_release_at) WHERE auto_release_at IS NOT NULL;
  `)
}
