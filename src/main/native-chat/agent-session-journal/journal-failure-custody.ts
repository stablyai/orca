import type Database from '../../sqlite/sync-database'
import { journalOrchestrationAttached } from './journal-failure-authority'

/** A waiting pointer represents its saved message ids, not one additional message. */
export function journalFailureCustodySql(db: Database.Database): string {
  return `WITH RECURSIVE target AS (SELECT ? AS session_id, ? AS epoch),
    lineage(session_id) AS (SELECT session_id FROM target UNION SELECT r.session_id
      FROM agent_session_records r JOIN lineage l ON json_extract(r.record_json,'$.conversationCommand.replacementSessionId')=l.session_id
      WHERE json_extract(r.record_json,'$.conversationCommand.command')='clear'
        AND json_extract(r.record_json,'$.conversationCommand.phase')='committed'),
    cards AS (SELECT q.message_id,q.payload_json FROM journal_queue_cards q,target t
      WHERE q.session_id=t.session_id AND q.epoch=t.epoch AND q.state='waiting'),
    pointers AS (SELECT c.message_id, json_extract(m.value,'$.messageId') AS source_id
      FROM cards c,json_each(c.payload_json,'$.body.from.orchestration.messages') m),
    source_rows AS (SELECT message_id AS id, json_extract(payload_json,'$.holdReason') IS NOT NULL AS held FROM cards WHERE message_id NOT IN (SELECT message_id FROM pointers)
      UNION ALL SELECT p.source_id, json_extract(c.payload_json,'$.holdReason') IS NOT NULL FROM pointers p JOIN cards c ON c.message_id=p.message_id
      ${
        journalOrchestrationAttached(db)
          ? `UNION ALL SELECT m.id,0 FROM orchestration_authority.messages m
        WHERE m.read=0 AND m.delivery_contract='current_delivery'
          AND (m.delivered_at IS NULL OR EXISTS(SELECT 1 FROM orchestration_authority.structured_mail_sends l WHERE l.mailbox_handle=m.to_handle AND l.message_id=m.id))
          AND NOT EXISTS(SELECT 1 FROM orchestration_authority.structured_mail_sends l
            JOIN journal_queue_cards q ON q.session_id=l.session_id AND q.message_id=l.operation_id
            JOIN journal_submission_attempts a ON a.session_id=q.session_id AND a.epoch=q.epoch
              AND a.message_id=json_extract(q.payload_json,'$.consumedAs') AND a.current=1 AND a.dispatch_state='accepted'
            WHERE l.mailbox_handle=m.to_handle AND l.message_id=m.id)
        AND m.to_handle IN (
          SELECT 'orca_session_id:' || session_id FROM lineage
          UNION SELECT 'dispatch:' || d.id FROM orchestration_authority.dispatch_contexts d,lineage t
            WHERE d.status='dispatched' AND (d.assignee_orca_session_id=t.session_id OR d.assignee_handle='orca_session_id:' || t.session_id)
          UNION SELECT d.assignee_handle FROM orchestration_authority.dispatch_contexts d,lineage t
            WHERE d.status='dispatched' AND (d.assignee_orca_session_id=t.session_id OR d.assignee_handle='orca_session_id:' || t.session_id)
          UNION SELECT 'run:' || r.id FROM orchestration_authority.runs r,lineage t
            WHERE r.coordinator_orca_session_id=t.session_id
              AND r.coordinator_orca_session_id_generation=r.consumer_generation)`
          : ''
      }), sources AS (SELECT id,MAX(held) AS held FROM source_rows GROUP BY id)`
}
