import type { OrchestrationDb } from '../orchestration-db'

/** Whom a Dispatch acts for, stamped once when it is made. Skipped when present. */
export function migrateV53(this: OrchestrationDb, current: number): void {
  if (current >= 53) {
    return
  }
  if (!this.hasColumn('dispatch_contexts', 'acts_for')) {
    this.db.exec('ALTER TABLE dispatch_contexts ADD COLUMN acts_for TEXT')
  }
}
