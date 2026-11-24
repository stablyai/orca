import type { OrchestrationDb } from '../orchestration-db'

/** Records a trusted bot-lineage stamp for a worker that runs on behalf of a paired Run home. */
export function migrateV52(this: OrchestrationDb, current: number): void {
  if (current < 52 && !this.hasColumn('remote_dispatch_attachments', 'chat_lineage')) {
    this.db.exec('ALTER TABLE remote_dispatch_attachments ADD COLUMN chat_lineage INTEGER')
  }
}
