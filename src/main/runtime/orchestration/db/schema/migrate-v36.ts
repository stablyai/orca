import type { OrchestrationDb } from '../orchestration-db'

/** Give both local and federated worker attachments consumer generations so stale workers cannot acknowledge replacement mail. */
export function migrateV36(this: OrchestrationDb, current: number): void {
  if (current >= 36) {
    return
  }
  for (const table of ['dispatch_contexts', 'remote_dispatch_attachments']) {
    if (!this.hasColumn(table, 'consumer_generation')) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN consumer_generation INTEGER NOT NULL DEFAULT 0`)
    }
  }
}
