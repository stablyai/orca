import type Database from '../../sqlite/sync-database'
import type { SqliteBindings } from '../../sqlite/sqlite-statement'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { journalDomainHistoryMetadata } from './journal-domain-history-metadata'
import { JOURNAL_DOMAIN_EDIT_LEASE_SCHEMA } from './journal-domain-edit-lease-schema'
import { migrateJournalDomainQueueSchema } from './journal-domain-queue-schema'

const JOURNAL_DOMAIN_VERSION = 4

/** journal_events.changes_json: identities only; readers load current rows for bodies. */
export type JournalDomainEventChanges = {
  items: { itemId: string; revision: number; sequence: number; sequenceIndex: number }[]
  submissions: string[]
  cards: string[]
  removedItemIds?: string[]
}

/** This ledger deliberately leaves the profile's global user_version unchanged. */
export function migrateJournalDomainSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS journal_domain_migrations (
    version INTEGER PRIMARY KEY
  )`)
  const version = Number(
    db.prepare('SELECT MAX(version) AS version FROM journal_domain_migrations').get()?.version ?? 0
  )
  if (version === JOURNAL_DOMAIN_VERSION) {
    return
  }
  if (version > JOURNAL_DOMAIN_VERSION) {
    throw new Error('journal domain schema is newer than this writer')
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    if (version < 1) {
      db.exec(JOURNAL_DOMAIN_V1)
    }
    if (version < 2) {
      migrateJournalDomainHistory(db)
    }
    if (version < 3) {
      db.exec(JOURNAL_DOMAIN_EDIT_LEASE_SCHEMA)
      db.exec(`CREATE INDEX journal_events_saved_at ON journal_events(saved_at,session_id,epoch,sequence);
        INSERT INTO journal_domain_migrations(version) VALUES (3)`)
    }
    migrateJournalDomainQueueSchema(db)
    db.exec('INSERT INTO journal_domain_migrations(version) VALUES (4)')
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** v2: history selects windows by these columns, so existing rows are backfilled once here. */
function migrateJournalDomainHistory(db: Database.Database): void {
  db.exec(`
ALTER TABLE journal_items ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
ALTER TABLE journal_items ADD COLUMN root INTEGER NOT NULL DEFAULT 1;
ALTER TABLE journal_items ADD COLUMN subagent_row INTEGER NOT NULL DEFAULT 0;
ALTER TABLE journal_items ADD COLUMN subagent_group_key TEXT;
ALTER TABLE journal_items ADD COLUMN named_subagent_ids TEXT;
ALTER TABLE journal_items ADD COLUMN turn_marker INTEGER NOT NULL DEFAULT 0;
CREATE INDEX journal_items_root_position ON journal_items(session_id, epoch, sequence, sequence_index, ordinal)
  WHERE hidden=0 AND root=1;
CREATE INDEX journal_items_turn_marker ON journal_items(session_id, epoch, sequence, sequence_index, ordinal)
  WHERE hidden=0 AND turn_marker=1;
CREATE INDEX journal_items_named_subagents ON journal_items(session_id, epoch, sequence, sequence_index, ordinal)
  WHERE hidden=0 AND root=1 AND named_subagent_ids IS NOT NULL;
`)
  const page = db.prepare(`SELECT session_id, epoch, item_id, payload_json FROM journal_items
    WHERE (session_id, epoch, item_id) > (?, ?, ?) ORDER BY session_id, epoch, item_id LIMIT 500`)
  const update = db.prepare(`UPDATE journal_items SET root=?, subagent_row=?, subagent_group_key=?,
    named_subagent_ids=?, turn_marker=? WHERE session_id=? AND epoch=? AND item_id=?`)
  let after: SqliteBindings = ['', '', '']
  for (let rows = page.all(...after); rows.length > 0; rows = page.all(...after)) {
    for (const row of rows) {
      const item: AgentJournalRenderItem = JSON.parse(String(row.payload_json))
      const metadata = journalDomainHistoryMetadata(item)
      update.run(
        metadata.root,
        metadata.subagentRow,
        metadata.subagentGroupKey,
        metadata.namedSubagentIds,
        metadata.turnMarker,
        row.session_id,
        row.epoch,
        row.item_id
      )
    }
    const last = rows.at(-1)!
    after = [last.session_id, last.epoch, last.item_id]
  }
  db.prepare('INSERT INTO journal_domain_migrations(version) VALUES (2)').run()
}

const JOURNAL_DOMAIN_V1 = `
CREATE TABLE journal_chat_state (
  session_id TEXT PRIMARY KEY,
  epoch TEXT NOT NULL,
  last_sequence INTEGER NOT NULL,
  retained_sequence INTEGER NOT NULL DEFAULT 0,
  highest_fence INTEGER NOT NULL,
  context_boundary INTEGER NOT NULL DEFAULT 0,
  last_activity_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE journal_items (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  item_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  sequence_index INTEGER NOT NULL,
  owner_fence INTEGER NOT NULL,
  execution_owner INTEGER,
  payload_json TEXT NOT NULL,
  PRIMARY KEY(session_id, epoch, item_id)
) WITHOUT ROWID;
CREATE INDEX journal_items_position ON journal_items(session_id, epoch, sequence, sequence_index, ordinal);
CREATE TABLE journal_item_tombstones (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  item_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY(session_id, epoch, item_id)
) WITHOUT ROWID;
CREATE TABLE journal_item_aliases (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  provider_item_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  echo_declared INTEGER NOT NULL DEFAULT 0,
  echo_json TEXT,
  PRIMARY KEY(session_id, epoch, provider_item_id)
) WITHOUT ROWID;
CREATE INDEX journal_item_aliases_target ON journal_item_aliases(session_id, epoch, item_id);
CREATE TABLE journal_submission_attempts (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  message_id TEXT NOT NULL,
  attempt_sequence INTEGER NOT NULL,
  attempt_index INTEGER NOT NULL,
  current INTEGER NOT NULL CHECK(current IN (0,1)),
  item_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  submitted_at INTEGER NOT NULL,
  accepted_sequence INTEGER,
  fingerprint TEXT NOT NULL,
  dispatch_state TEXT NOT NULL,
  candidate INTEGER NOT NULL DEFAULT 0,
  source_card_sequence INTEGER,
  source_card_index INTEGER,
  payload_json TEXT NOT NULL,
  PRIMARY KEY(session_id, epoch, message_id, attempt_sequence, attempt_index)
) WITHOUT ROWID;
CREATE UNIQUE INDEX journal_submission_head ON journal_submission_attempts(session_id, epoch, message_id) WHERE current=1;
CREATE UNIQUE INDEX journal_submission_item ON journal_submission_attempts(session_id, epoch, item_id) WHERE current=1;
CREATE INDEX journal_submission_echo ON journal_submission_attempts(session_id, epoch, fingerprint, submitted_at, ordinal) WHERE current=1;
CREATE INDEX journal_submission_acceptance ON journal_submission_attempts(session_id, epoch, accepted_sequence DESC) WHERE dispatch_state='accepted';
CREATE TABLE journal_send_receipts (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  message_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY(session_id, epoch, message_id)
) WITHOUT ROWID;
CREATE TABLE journal_card_versions (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  message_id TEXT NOT NULL,
  version_sequence INTEGER NOT NULL,
  version_index INTEGER NOT NULL,
  current INTEGER NOT NULL CHECK(current IN (0,1)),
  state TEXT NOT NULL,
  command_turn_item_id TEXT,
  payload_json TEXT NOT NULL,
  PRIMARY KEY(session_id, epoch, message_id, version_sequence, version_index)
) WITHOUT ROWID;
CREATE UNIQUE INDEX journal_card_head ON journal_card_versions(session_id, epoch, message_id) WHERE current=1;
CREATE INDEX journal_returned_commands ON journal_card_versions(session_id, epoch, command_turn_item_id) WHERE current=1 AND state='returned';
CREATE TABLE journal_provider_activity (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  fence INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  PRIMARY KEY(session_id, epoch, fence)
) WITHOUT ROWID;
CREATE TABLE journal_events (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  saved_at INTEGER NOT NULL,
  changes_json TEXT NOT NULL,
  PRIMARY KEY(session_id, epoch, sequence)
) WITHOUT ROWID;
INSERT INTO journal_domain_migrations(version) VALUES (1);
`
