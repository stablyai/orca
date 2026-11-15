import type Database from '../../../sqlite/sync-database'
import { runJournalTransaction } from './journal-database'
import { JOURNAL_DOMAIN_SCHEMA_001 } from './journal-domain-schema-001'

export const JOURNAL_DOMAIN_SCHEMA_VERSION = 3

/** The domain database starts at one frozen schema; shipped source formats import separately. */
export function migrateJournalDomainSchema(db: Database.Database): void {
  const stored = Number(db.pragma('user_version', { simple: true }))
  if (stored > JOURNAL_DOMAIN_SCHEMA_VERSION) {
    throw new Error('journal domain schema is newer than this writer')
  }
  if (stored < JOURNAL_DOMAIN_SCHEMA_VERSION) {
    runJournalTransaction(db, () => {
      if (stored < 1) {
        db.exec(JOURNAL_DOMAIN_SCHEMA_001)
      } else if (stored === 1) {
        db.exec('ALTER TABLE journal_items ADD COLUMN wire_version INTEGER')
      }
      if (stored < 3) {
        db.exec(`CREATE TABLE journal_failure_resumes (
          session_id TEXT NOT NULL, epoch TEXT NOT NULL, failure_id TEXT NOT NULL,
          source_item_id TEXT NOT NULL, failed_at INTEGER NOT NULL,
          operation_id TEXT NOT NULL, coordinator_id TEXT NOT NULL, dispatch_id TEXT NOT NULL,
          released_at INTEGER NOT NULL,
          PRIMARY KEY(session_id,epoch,source_item_id,failed_at),
          UNIQUE(session_id,epoch,failure_id), UNIQUE(session_id,epoch,operation_id)
        );
        CREATE INDEX journal_failure_resume_latest ON journal_failure_resumes(session_id,epoch,released_at DESC);
        CREATE INDEX journal_failure_report_latest ON journal_items(session_id,epoch,queue_failure_report_turn_item_id,ordinal DESC)
          WHERE hidden=0 AND queue_failure_report_turn_item_id IS NOT NULL;`)
      }
      db.pragma(`user_version = ${JOURNAL_DOMAIN_SCHEMA_VERSION}`)
    })
  }
}
