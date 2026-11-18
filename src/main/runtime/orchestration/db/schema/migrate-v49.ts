import type { OrchestrationDb } from '../orchestration-db'

export function migrateV49(this: OrchestrationDb, current: number): void {
  if (current < 49 && !this.hasColumn('dispatch_contexts', 'native_usage_identity')) {
    this.db.exec('ALTER TABLE dispatch_contexts ADD COLUMN native_usage_identity TEXT')
  }
}
