import type { OrchestrationDb } from '../orchestration-db'

export function migrateV40(this: OrchestrationDb, current: number): void {
  if (current >= 40 || this.hasColumn('remote_dispatch_attachments', 'home_run_id')) {
    return
  }
  // Federation is unreleased; any development-only rows fail Run validation until reattached.
  this.db.exec(
    "ALTER TABLE remote_dispatch_attachments ADD COLUMN home_run_id TEXT NOT NULL DEFAULT ''"
  )
}
