import type SyncDatabase from '../../sqlite/sync-database'

const ROOM_PARTICIPANT_COLUMNS = `id, room_id, identity, display_name, actor_kind, agent,
  role_id, worktree_id, pane_key, terminal_handle, provider_session_json, process_incarnation,
  terminal_surface_visible, participation, state, context_json, last_seen_at, created_at, updated_at`

export function roomParticipantsTableSql(tableName: string): string {
  return `CREATE TABLE ${tableName} (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        identity TEXT NOT NULL COLLATE NOCASE CHECK(length(trim(identity)) BETWEEN 1 AND 80),
        display_name TEXT NOT NULL CHECK(length(trim(display_name)) BETWEEN 1 AND 120),
        actor_kind TEXT NOT NULL CHECK(actor_kind IN ('user', 'agent')),
        agent TEXT CHECK(agent IN ('claude', 'openclaude', 'codex', 'grok', 'omp')),
        role_id TEXT REFERENCES room_roles(id) ON DELETE SET NULL,
        worktree_id TEXT,
        pane_key TEXT,
        terminal_handle TEXT,
        provider_session_json TEXT,
        process_incarnation TEXT,
        terminal_surface_visible INTEGER NOT NULL DEFAULT 0
          CHECK(terminal_surface_visible IN (0, 1)),
        participation TEXT NOT NULL DEFAULT 'active'
          CHECK(participation IN ('active', 'paused')),
        state TEXT NOT NULL DEFAULT 'offline'
          CHECK(state IN ('starting', 'online', 'busy', 'sleeping', 'offline', 'error')),
        context_json TEXT NOT NULL DEFAULT '{}',
        last_seen_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(room_id, identity),
        CHECK((actor_kind = 'agent' AND agent IS NOT NULL) OR (actor_kind = 'user' AND agent IS NULL))
      );`
}

export function ensureRoomParticipantParticipationSchema(db: SyncDatabase.Database): void {
  const columns = db.pragma('table_info(room_participants)') as { name: string }[]
  if (!columns.some((column) => column.name === 'participation')) {
    db.exec(
      "ALTER TABLE room_participants ADD COLUMN participation TEXT NOT NULL DEFAULT 'active' CHECK(participation IN ('active', 'paused'))"
    )
  }
}

export function ensureRoomParticipantAgentSchema(db: SyncDatabase.Database): void {
  const table = participantTableSql(db)
  if (table?.includes("'omp'")) {
    return
  }
  rebuildParticipants(db)
}

export function ensureRoomParticipantSleepingStateSchema(db: SyncDatabase.Database): void {
  const table = participantTableSql(db)
  if (!table || table.includes("'sleeping'")) {
    return
  }
  rebuildParticipants(db)
}

function participantTableSql(db: SyncDatabase.Database): string | null {
  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'room_participants'")
    .get() as { sql: string } | undefined
  return table?.sql ?? null
}

function rebuildParticipants(db: SyncDatabase.Database): void {
  db.pragma('foreign_keys = OFF')
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`
      ${roomParticipantsTableSql('room_participants_new')}
      INSERT INTO room_participants_new (${ROOM_PARTICIPANT_COLUMNS})
      SELECT ${ROOM_PARTICIPANT_COLUMNS} FROM room_participants;
      DROP TABLE room_participants;
      ALTER TABLE room_participants_new RENAME TO room_participants;
      CREATE INDEX idx_room_participants_handle ON room_participants(terminal_handle);
      CREATE INDEX idx_room_participants_pane ON room_participants(pane_key);
    `)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    db.pragma('foreign_keys = ON')
  }
}
