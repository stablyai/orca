import type { OrchestrationDb } from '../orchestration-db'

/** A follow-up Dispatch's link to the worker it continues, mail its worker left unread when it reported, and the conversation a closed worker reopens. */
export function migrateV46(this: OrchestrationDb, current: number): void {
  if (current >= 46) {
    return
  }
  if (!this.hasColumn('dispatch_contexts', 'follow_up_of_dispatch_id')) {
    this.db.exec('ALTER TABLE dispatch_contexts ADD COLUMN follow_up_of_dispatch_id TEXT')
  }
  if (!this.hasColumn('dispatch_contexts', 'follow_up_mail_at')) {
    this.db.exec('ALTER TABLE dispatch_contexts ADD COLUMN follow_up_mail_at TEXT')
  }
  if (!this.hasColumn('worker_terminal_resources', 'resume_session')) {
    this.db.exec('ALTER TABLE worker_terminal_resources ADD COLUMN resume_session TEXT')
  }
  this.db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_contexts_follow_up_of
      ON dispatch_contexts(follow_up_of_dispatch_id) WHERE follow_up_of_dispatch_id IS NOT NULL;
  `)
}
