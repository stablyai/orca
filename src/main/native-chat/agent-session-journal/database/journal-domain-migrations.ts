import type Database from '../../../sqlite/sync-database'
import type { SqliteBindings } from '../../../sqlite/sqlite-statement'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { journalDomainHistoryMetadata } from '../journal-domain-history-metadata'
import { JOURNAL_DOMAIN_EDIT_LEASE_SCHEMA } from '../journal-domain-edit-lease-schema'
import { migrateJournalDomainQueueSchema } from '../journal-domain-queue-schema'
import { ensureJournalOutcomeTables } from '../outcomes/journal-outcome-format'
import { ensureCommandReceiptsTable } from '../writing/command-receipt-schema'
import { ensureAgentSessionAttachmentClaimTables } from '../../agent-session-attachments/agent-session-attachment-claims'
import { runJournalTransaction } from './journal-database'
import {
  createAgentSessionRecordTablesSql,
  createJournalTablesSql
} from './journal-database-schema'

const JOURNAL_DOMAIN_MIGRATIONS: readonly {
  version: number
  migrate: (db: Database.Database) => void
}[] = [
  { version: 3, migrate: (db) => db.exec(createJournalTablesSql()) },
  { version: 4, migrate: (db) => db.exec(createAgentSessionRecordTablesSql()) },
  { version: 5, migrate: createJournalDomainTables },
  { version: 6, migrate: migrateJournalDomainHistory },
  {
    version: 7,
    migrate: (db) =>
      db.exec(`${JOURNAL_DOMAIN_EDIT_LEASE_SCHEMA}
      CREATE INDEX journal_events_saved_at ON journal_events(saved_at,session_id,epoch,sequence);`)
  },
  { version: 8, migrate: migrateJournalDomainQueueSchema },
  { version: 9, migrate: dropJournalProjectionTables }
]

export const JOURNAL_DOMAIN_SCHEMA_VERSION = JOURNAL_DOMAIN_MIGRATIONS.at(-1)!.version

/** Each completed step and its version commit together; reopen resumes the next step. */
export function migrateJournalDomainSchema(db: Database.Database): void {
  const stored = Number(db.pragma('user_version', { simple: true }))
  if (stored > JOURNAL_DOMAIN_SCHEMA_VERSION) {
    throw new Error('journal domain schema is newer than this writer')
  }
  for (const migration of JOURNAL_DOMAIN_MIGRATIONS) {
    if (migration.version > stored) {
      runJournalTransaction(db, () => {
        migration.migrate(db)
        db.pragma(`user_version = ${migration.version}`)
      })
    }
  }
}

function createJournalDomainTables(db: Database.Database): void {
  // Released files added these tables without version bumps; frozen source remains decodable.
  db.exec(createJournalTablesSql() + createAgentSessionRecordTablesSql())
  db.exec(`CREATE TABLE IF NOT EXISTS queued_messages (
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    body_json TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    host_instance TEXT NOT NULL,
    state TEXT NOT NULL,
    hold_reason TEXT,
    returned_reason TEXT,
    returned_rejection TEXT,
    settled_at INTEGER,
    settled_by_op TEXT,
    consumed_as TEXT,
    carried_from TEXT,
    queued_epoch TEXT,
    queued_sequence INTEGER,
    options_json TEXT,
    PRIMARY KEY (session_id, message_id)
  );
  CREATE INDEX IF NOT EXISTS idx_agent_session_clear_successor
    ON agent_session_records(CASE WHEN json_valid(record_json)
      THEN json_extract(record_json, '$.conversationCommand.replacementSessionId') END);`)
  ensureCommandReceiptsTable(db)
  ensureJournalOutcomeTables(db)
  ensureAgentSessionAttachmentClaimTables(db)
  db.exec(JOURNAL_DOMAIN_V1)
}

function dropJournalProjectionTables(db: Database.Database): void {
  const tables = db
    .prepare(`SELECT name FROM sqlite_schema
    WHERE type='table' AND name GLOB 'journal_proj_*'`)
    .all()
  for (const { name } of tables) {
    db.exec(`DROP TABLE "${String(name).replaceAll('"', '""')}"`)
  }
  db.exec('DROP TABLE IF EXISTS journal_domain_migrations')
}

/** History selects windows by these columns, so existing rows are backfilled once here. */
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
`
