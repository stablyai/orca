import type SyncDatabase from '../../sqlite/sync-database'
import { ensureRoomActivitySchema } from './activities'
import { ensureRoomDeliveryConfigurationSchema } from './delivery-configuration'
import {
  ensureRoomParticipantParticipationSchema,
  ensureRoomParticipantSleepingStateSchema,
  roomParticipantsTableSql
} from './participants'

export function initializeRoomSchema(db: SyncDatabase.Database): void {
  db.pragma('foreign_keys = ON')
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')
  if (hasTable(db, 'rooms')) {
    ensureRoomWorktreeSchema(db)
    ensureRoomDeliveryTurnSchema(db)
    ensureRoomDeliveryReliabilitySchema(db)
    ensureRoomParticipantIncarnationSchema(db)
    ensureRoomParticipantParticipationSchema(db)
    ensureRoomParticipantTerminalSurfaceSchema(db)
    ensureRoomParticipantSleepingStateSchema(db)
    ensureRoomActivitySchema(db)
    ensureRoomDeliveryConfigurationSchema(db)
    ensureRoomMessageMentionOrderSchema(db)
    return
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`
      CREATE TABLE rooms (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        worktree_id TEXT,
        name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
        description TEXT NOT NULL DEFAULT '',
        loop_limit INTEGER NOT NULL DEFAULT 0 CHECK(loop_limit BETWEEN 0 AND 20),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived_at INTEGER
      );
      CREATE INDEX idx_rooms_project_updated ON rooms(project_id, updated_at DESC);

      CREATE TABLE room_roles (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        name TEXT NOT NULL COLLATE NOCASE CHECK(length(trim(name)) BETWEEN 1 AND 80),
        prompt TEXT NOT NULL CHECK(length(prompt) <= 4000),
        is_preset INTEGER NOT NULL DEFAULT 0 CHECK(is_preset IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(room_id, name)
      );

      ${roomParticipantsTableSql('room_participants')}
      CREATE INDEX idx_room_participants_handle ON room_participants(terminal_handle);
      CREATE INDEX idx_room_participants_pane ON room_participants(pane_key);

      CREATE TABLE room_messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        sender_id TEXT REFERENCES room_participants(id) ON DELETE SET NULL,
        sender_identity TEXT NOT NULL,
        actor_kind TEXT NOT NULL CHECK(actor_kind IN ('user', 'agent', 'system')),
        kind TEXT NOT NULL DEFAULT 'chat'
          CHECK(kind IN ('chat', 'system', 'decision', 'proposal')),
        body TEXT NOT NULL CHECK(length(body) <= 262144),
        reply_to_id TEXT REFERENCES room_messages(id) ON DELETE SET NULL,
        root_message_id TEXT,
        hop_count INTEGER NOT NULL DEFAULT 0 CHECK(hop_count >= 0),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        edited_at INTEGER,
        deleted_at INTEGER
      );
      CREATE INDEX idx_room_messages_page ON room_messages(room_id, sequence DESC);

      CREATE TABLE room_attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES room_messages(id) ON DELETE CASCADE,
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
        local_path TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_room_attachments_message ON room_attachments(message_id);

      CREATE TABLE room_message_mentions (
        message_id TEXT NOT NULL REFERENCES room_messages(id) ON DELETE CASCADE,
        identity TEXT NOT NULL COLLATE NOCASE,
        position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(message_id, identity)
      );

      CREATE TABLE room_deliveries (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES room_messages(id) ON DELETE CASCADE,
        participant_id TEXT NOT NULL REFERENCES room_participants(id) ON DELETE CASCADE,
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK(state IN ('pending', 'delivering', 'delivered', 'failed', 'suppressed')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        error TEXT,
        next_attempt_at INTEGER NOT NULL,
        delivered_at INTEGER,
        provider_turn_id TEXT,
        response_message_id TEXT REFERENCES room_messages(id) ON DELETE SET NULL,
        responded_at INTEGER,
        phase TEXT CHECK(phase IN ('waking', 'submitting', 'awaiting-turn')),
        attempt_history_json TEXT NOT NULL DEFAULT '[]',
        UNIQUE(message_id, participant_id)
      );
      CREATE INDEX idx_room_deliveries_due
        ON room_deliveries(state, next_attempt_at) WHERE state IN ('pending', 'failed');

      CREATE TABLE room_reads (
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        reader_key TEXT NOT NULL,
        last_read_sequence INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(room_id, reader_key)
      );

      CREATE TABLE room_provider_streams (
        participant_id TEXT PRIMARY KEY REFERENCES room_participants(id) ON DELETE CASCADE,
        provider_session_id TEXT NOT NULL,
        initialized_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE room_provider_messages (
        participant_id TEXT NOT NULL REFERENCES room_participants(id) ON DELETE CASCADE,
        provider_session_id TEXT NOT NULL,
        provider_message_id TEXT NOT NULL,
        room_message_id TEXT REFERENCES room_messages(id) ON DELETE SET NULL,
        observed_at INTEGER NOT NULL,
        PRIMARY KEY(participant_id, provider_session_id, provider_message_id)
      );
      CREATE INDEX idx_room_provider_messages_room_message
        ON room_provider_messages(room_message_id);

      CREATE TABLE room_agent_activity (
        participant_id TEXT PRIMARY KEY REFERENCES room_participants(id) ON DELETE CASCADE,
        activity_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE room_pins (
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES room_messages(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo', 'done')),
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(room_id, message_id)
      );
      CREATE INDEX idx_room_pins_status ON room_pins(room_id, status, created_at DESC);
    `)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  ensureRoomDeliveryConfigurationSchema(db)
}

function ensureRoomMessageMentionOrderSchema(db: SyncDatabase.Database): void {
  const columns = db.pragma('table_info(room_message_mentions)') as { name: string }[]
  if (!columns.some((column) => column.name === 'position')) {
    db.exec('ALTER TABLE room_message_mentions ADD COLUMN position INTEGER NOT NULL DEFAULT 0')
  }
}

function ensureRoomDeliveryTurnSchema(db: SyncDatabase.Database): void {
  const columns = db.pragma('table_info(room_deliveries)') as { name: string }[]
  if (!columns.some((column) => column.name === 'provider_turn_id')) {
    db.exec('ALTER TABLE room_deliveries ADD COLUMN provider_turn_id TEXT')
  }
}

function ensureRoomDeliveryReliabilitySchema(db: SyncDatabase.Database): void {
  const columns = db.pragma('table_info(room_deliveries)') as { name: string }[]
  if (!columns.some((column) => column.name === 'phase')) {
    db.exec(
      "ALTER TABLE room_deliveries ADD COLUMN phase TEXT CHECK(phase IN ('waking', 'submitting', 'awaiting-turn'))"
    )
  }
  if (!columns.some((column) => column.name === 'attempt_history_json')) {
    db.exec(
      "ALTER TABLE room_deliveries ADD COLUMN attempt_history_json TEXT NOT NULL DEFAULT '[]'"
    )
  }
}

function ensureRoomParticipantIncarnationSchema(db: SyncDatabase.Database): void {
  const columns = db.pragma('table_info(room_participants)') as { name: string }[]
  if (!columns.some((column) => column.name === 'process_incarnation')) {
    db.exec('ALTER TABLE room_participants ADD COLUMN process_incarnation TEXT')
  }
}

function ensureRoomParticipantTerminalSurfaceSchema(db: SyncDatabase.Database): void {
  const columns = db.pragma('table_info(room_participants)') as { name: string }[]
  if (!columns.some((column) => column.name === 'terminal_surface_visible')) {
    db.exec(
      'ALTER TABLE room_participants ADD COLUMN terminal_surface_visible INTEGER NOT NULL DEFAULT 0 CHECK(terminal_surface_visible IN (0, 1))'
    )
  }
}

function hasTable(db: SyncDatabase.Database, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  )
}

function ensureRoomWorktreeSchema(db: SyncDatabase.Database): void {
  const columns = db.pragma('table_info(rooms)') as { name: string }[]
  if (!columns.some((column) => column.name === 'worktree_id')) {
    db.exec('ALTER TABLE rooms ADD COLUMN worktree_id TEXT')
  }
  db.exec(`
    UPDATE rooms
    SET worktree_id = (
      SELECT participant.worktree_id
      FROM room_participants AS participant
      WHERE participant.room_id = rooms.id AND participant.worktree_id IS NOT NULL
      ORDER BY participant.created_at, participant.id
      LIMIT 1
    )
    WHERE worktree_id IS NULL
  `)
}
