import type { OrchestrationDb } from '../orchestration-db'
import { backfillFederatedStubHomeRuns } from '../federation/federated-stub-home-run-backfill'

export function migrateV40(this: OrchestrationDb, current: number): void {
  if (current >= 40) {
    return
  }
  if (!this.hasColumn('remote_dispatch_attachments', 'home_run_id')) {
    this.db.exec(
      "ALTER TABLE remote_dispatch_attachments ADD COLUMN home_run_id TEXT NOT NULL DEFAULT ''"
    )
  }
  // Why: workers attached by v1.4.198 keep a mailbox; without a Run their control mail is refused.
  backfillFederatedStubHomeRuns(this.db)
}
