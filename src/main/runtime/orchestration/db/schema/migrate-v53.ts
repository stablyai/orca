import type { OrchestrationDb } from '../orchestration-db'

/** Separates inherited bot commit guidance from worker surface and lifecycle state. */
export function migrateV53(this: OrchestrationDb, current: number): void {
  if (current >= 53) {
    return
  }
  if (!this.hasColumn('dispatch_contexts', 'bot_lineage')) {
    this.db.exec('ALTER TABLE dispatch_contexts ADD COLUMN bot_lineage INTEGER')
  }
  if (!this.hasColumn('remote_dispatch_attachments', 'bot_lineage')) {
    this.db.exec('ALTER TABLE remote_dispatch_attachments ADD COLUMN bot_lineage INTEGER')
  }
  if (!this.hasColumn('remote_placements', 'bot_lineage')) {
    this.db.exec('ALTER TABLE remote_placements ADD COLUMN bot_lineage INTEGER')
  }
  if (!this.hasColumn('remote_dispatches', 'bot_lineage')) {
    this.db.exec('ALTER TABLE remote_dispatches ADD COLUMN bot_lineage INTEGER')
  }
}
