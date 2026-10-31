import type { OrchestrationDb } from '../orchestration-db'

/** The home's release deadline for hosts that cannot release settled workers themselves. */
export function migrateV45(this: OrchestrationDb, current: number): void {
  if (current >= 45) {
    return
  }
  for (const column of ['home_auto_release_at', 'home_auto_release_state']) {
    if (!this.hasColumn('federated_dispatches', column)) {
      this.db.exec(`ALTER TABLE federated_dispatches ADD COLUMN ${column} TEXT`)
    }
  }
  this.db.exec(`
    CREATE INDEX IF NOT EXISTS idx_federated_dispatches_home_auto_release
      ON federated_dispatches(home_auto_release_at) WHERE home_auto_release_at IS NOT NULL;
  `)
}
