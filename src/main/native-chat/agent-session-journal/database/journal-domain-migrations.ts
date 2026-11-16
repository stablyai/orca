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
          released_at INTEGER NOT NULL, authority_json TEXT, attempted_message_id TEXT,
          sources_json TEXT NOT NULL DEFAULT '[]',
          PRIMARY KEY(session_id,epoch,source_item_id,failed_at),
          UNIQUE(session_id,epoch,failure_id), UNIQUE(session_id,epoch,operation_id)
        );
        CREATE INDEX journal_failure_resume_latest ON journal_failure_resumes(session_id,epoch,released_at DESC);
        CREATE INDEX journal_failure_report_latest ON journal_items(session_id,epoch,queue_failure_report_turn_item_id,ordinal DESC)
          WHERE hidden=0 AND queue_failure_report_turn_item_id IS NOT NULL;
        CREATE INDEX journal_failed_session_candidates ON journal_items(session_id,epoch,queue_failed_at)
          WHERE hidden=0 AND queue_failed_outcome=1 AND queue_failed_at>0;
        CREATE INDEX journal_failure_mail_lineage ON agent_session_records(json_extract(record_json,'$.conversationCommand.replacementSessionId'))
          WHERE json_extract(record_json,'$.conversationCommand.command')='clear' AND json_extract(record_json,'$.conversationCommand.phase')='committed';
        CREATE TRIGGER journal_failure_resume_attempt AFTER INSERT ON journal_submission_attempts
          WHEN NEW.queued=1
          BEGIN UPDATE journal_failure_resumes SET attempted_message_id=NEW.message_id
            WHERE session_id=NEW.session_id AND epoch=NEW.epoch AND attempted_message_id IS NULL
              AND released_at=(SELECT MAX(released_at) FROM journal_failure_resumes WHERE session_id=NEW.session_id AND epoch=NEW.epoch)
              AND released_at<NEW.attempt_sequence
              AND EXISTS(SELECT 1 FROM json_each(sources_json) wanted WHERE wanted.value=json_extract(NEW.payload_json,'$.queuedMessageId')
                OR EXISTS(SELECT 1 FROM json_each(NEW.admission_body_json,'$.from.orchestration.messages') m
                  WHERE json_extract(m.value,'$.messageId')=wanted.value))
              AND NOT EXISTS(SELECT 1 FROM journal_submission_attempts a WHERE a.session_id=NEW.session_id AND a.epoch=NEW.epoch
                AND a.admitted_personal=1 AND a.attempt_sequence>released_at
                AND NOT EXISTS(SELECT 1 FROM json_each(sources_json) wanted WHERE wanted.value=json_extract(a.payload_json,'$.queuedMessageId')));
          END;`)
      }
      db.pragma(`user_version = ${JOURNAL_DOMAIN_SCHEMA_VERSION}`)
    })
  }
}
