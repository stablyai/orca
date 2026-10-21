import type { OrchestrationDb } from '../orchestration-db'

/**
 * `dispatch:<id>` mailboxes had no consumer generation, so every process that ever attached to a
 * Dispatch shared one Delivery and either could acknowledge it. Both worker-side attachment tables
 * get their own counter: a federated worker host holds no `dispatch_contexts` row for the Dispatch
 * it serves, only a `remote_dispatch_attachments` row.
 */
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
