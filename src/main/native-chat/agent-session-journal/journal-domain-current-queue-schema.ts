/**
 * One current queue row per card, updated in place. `revision` advances on content or state
 * changes only, so an edit hold names it instead of copying the card. Admission provenance moves
 * onto the attempt from the exact card version it named; a missing version reads as not personal.
 * Runs once, after the queue position schema, inside the caller's migration transaction.
 */
export const JOURNAL_DOMAIN_CURRENT_QUEUE_SCHEMA = `
CREATE TABLE journal_queue_cards (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  message_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  state TEXT NOT NULL,
  position REAL NOT NULL,
  command_turn_item_id TEXT,
  payload_json TEXT NOT NULL,
  PRIMARY KEY(session_id, epoch, message_id)
) WITHOUT ROWID;
INSERT INTO journal_queue_cards(session_id,epoch,message_id,revision,state,position,command_turn_item_id,payload_json)
  SELECT session_id, epoch, message_id, 1, state,
    COALESCE(position, json_extract(payload_json,'$.position'), 0), command_turn_item_id,
    json_remove(payload_json,'$.messageId','$.position','$.state','$.fingerprint')
  FROM journal_card_versions WHERE current=1;
CREATE INDEX journal_queue_order ON journal_queue_cards(session_id, epoch, position, message_id)
  WHERE state IN ('waiting','returned');
CREATE INDEX journal_queue_last_position ON journal_queue_cards(session_id, epoch, position);
CREATE INDEX journal_queue_returned_commands ON journal_queue_cards(session_id, epoch, command_turn_item_id)
  WHERE state='returned';

ALTER TABLE journal_submission_attempts ADD COLUMN admitted_personal INTEGER NOT NULL DEFAULT 0
  CHECK(admitted_personal IN (0,1));
UPDATE journal_submission_attempts SET admitted_personal=1
  WHERE json_type(payload_json,'$.queuedMessageId') IS NOT NULL
    AND EXISTS(SELECT 1 FROM journal_card_versions AS card
      WHERE card.session_id=journal_submission_attempts.session_id
        AND card.epoch=journal_submission_attempts.epoch
        AND card.message_id=json_extract(journal_submission_attempts.payload_json,'$.queuedMessageId')
        AND card.version_sequence=journal_submission_attempts.source_card_sequence
        AND card.version_index=journal_submission_attempts.source_card_index
        AND COALESCE(json_extract(card.payload_json,'$.unattended'),0)<>1
        AND json_type(card.payload_json,'$.body.from') IS NULL);
DROP INDEX IF EXISTS journal_submission_source_card;
ALTER TABLE journal_submission_attempts DROP COLUMN source_card_sequence;
ALTER TABLE journal_submission_attempts DROP COLUMN source_card_index;

CREATE TABLE journal_edit_holds (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  caller_key TEXT NOT NULL,
  edit_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  card_revision INTEGER NOT NULL,
  expires_at REAL NOT NULL,
  PRIMARY KEY(session_id, epoch, owner_id, caller_key, edit_id)
) WITHOUT ROWID;
INSERT INTO journal_edit_holds(session_id,epoch,owner_id,caller_key,edit_id,message_id,card_revision,expires_at)
  SELECT lease.session_id, lease.epoch, lease.owner_id, lease.caller_key, lease.edit_id,
    lease.message_id, card.revision, lease.expires_at
  FROM journal_edit_leases AS lease
  JOIN journal_card_versions AS former ON former.session_id=lease.session_id AND former.epoch=lease.epoch
    AND former.message_id=lease.message_id AND former.current=1 AND former.state=lease.state
    AND json_extract(former.payload_json,'$.consumedAs') IS lease.consumed_as
  JOIN journal_queue_cards AS card ON card.session_id=lease.session_id AND card.epoch=lease.epoch
    AND card.message_id=lease.message_id;
DROP TABLE journal_edit_leases;
ALTER TABLE journal_edit_holds RENAME TO journal_edit_leases;
CREATE INDEX journal_edit_leases_message ON journal_edit_leases(session_id, epoch, message_id);
CREATE INDEX journal_edit_leases_deadline ON journal_edit_leases(session_id, epoch, expires_at);

DROP TABLE journal_card_versions;
`
