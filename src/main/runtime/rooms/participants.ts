import { randomUUID } from 'node:crypto'
import type SyncDatabase from '../../sqlite/sync-database'
import {
  EMPTY_ROOM_CONTEXT,
  type RoomHarnessAgent,
  type RoomParticipant,
  type RoomProviderSession
} from '../../../shared/rooms'
import { participantFromRow, type RoomRow } from './rows'
import { findRoomAgentOwner, type RoomAgentOwnershipIdentity } from './participant-ownership'

const ROOM_PARTICIPANT_COLUMNS = `id, room_id, identity, display_name, actor_kind, agent,
  role_id, worktree_id, pane_key, terminal_handle, provider_session_json, process_incarnation,
  terminal_surface_visible, participation, state, context_json, last_seen_at, created_at, updated_at`

/** Single source for the table shape: the fresh schema and the CHECK-extension
 *  rebuild (SQLite cannot alter a CHECK in place) must never drift apart. */
export function roomParticipantsTableSql(tableName: string): string {
  return `CREATE TABLE ${tableName} (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        identity TEXT NOT NULL COLLATE NOCASE CHECK(length(trim(identity)) BETWEEN 1 AND 80),
        display_name TEXT NOT NULL CHECK(length(trim(display_name)) BETWEEN 1 AND 120),
        actor_kind TEXT NOT NULL CHECK(actor_kind IN ('user', 'agent')),
        agent TEXT CHECK(agent IN ('claude', 'openclaude', 'codex', 'grok')),
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

/** 12-step rebuild adding the 'sleeping' state; FK enforcement toggles outside
 *  the txn. Runs after the incarnation migration so the column list is complete. */
export function ensureRoomParticipantSleepingStateSchema(db: SyncDatabase.Database): void {
  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'room_participants'")
    .get() as { sql: string } | undefined
  if (!table || table.sql.includes("'sleeping'")) {
    return
  }
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
  }
  db.pragma('foreign_keys = ON')
}

export class RoomParticipantStore {
  constructor(private readonly db: SyncDatabase.Database) {}

  list(roomId: string): RoomParticipant[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM room_participants WHERE room_id = ? ORDER BY actor_kind = 'user' DESC, created_at"
        )
        .all(roomId) as RoomRow[]
    ).map(participantFromRow)
  }

  add(input: {
    id?: string
    roomId: string
    identity: string
    displayName: string
    agent: RoomHarnessAgent
    roleId?: string | null
    worktreeId?: string | null
    paneKey?: string | null
    terminalHandle?: string | null
    providerSession?: RoomProviderSession | null
    processIncarnation?: string | null
    terminalSurfaceVisible?: boolean
  }): RoomParticipant {
    if (input.roleId) {
      const role = this.db
        .prepare('SELECT 1 FROM room_roles WHERE id = ? AND room_id = ?')
        .get(input.roleId, input.roomId)
      if (!role) {
        throw new Error('room_role_not_found')
      }
    }
    if (this.findOwner(input)) {
      throw new Error('room_agent_already_in_room')
    }
    const id = input.id ?? randomUUID()
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO room_participants (
          id, room_id, identity, display_name, actor_kind, agent, role_id, worktree_id,
          pane_key, terminal_handle, provider_session_json, process_incarnation,
          terminal_surface_visible, context_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'agent', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.roomId,
        input.identity.trim(),
        input.displayName.trim(),
        input.agent,
        input.roleId ?? null,
        input.worktreeId ?? null,
        input.paneKey ?? null,
        input.terminalHandle ?? null,
        input.providerSession ? JSON.stringify(input.providerSession) : null,
        input.processIncarnation ?? null,
        input.terminalSurfaceVisible ? 1 : 0,
        JSON.stringify(EMPTY_ROOM_CONTEXT),
        now,
        now
      )
    return this.get(id)
  }

  update(
    id: string,
    input: Partial<
      Pick<
        RoomParticipant,
        | 'identity'
        | 'displayName'
        | 'roleId'
        | 'worktreeId'
        | 'paneKey'
        | 'terminalHandle'
        | 'providerSession'
        | 'processIncarnation'
        | 'terminalSurfaceVisible'
        | 'participation'
        | 'state'
        | 'context'
        | 'lastSeenAt'
      >
    >
  ): RoomParticipant {
    const current = this.get(id)
    if (input.roleId) {
      const role = this.db
        .prepare('SELECT 1 FROM room_roles WHERE id = ? AND room_id = ?')
        .get(input.roleId, current.roomId)
      if (!role) {
        throw new Error('room_role_not_found')
      }
    }
    const now = Date.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(
          `UPDATE room_participants SET identity = ?, display_name = ?, role_id = ?, worktree_id = ?,
           pane_key = ?, terminal_handle = ?, provider_session_json = ?, process_incarnation = ?,
           terminal_surface_visible = ?, participation = ?, state = ?, context_json = ?,
           last_seen_at = ?, updated_at = ? WHERE id = ?`
        )
        .run(
          input.identity?.trim() ?? current.identity,
          input.displayName?.trim() ?? current.displayName,
          input.roleId === undefined ? current.roleId : input.roleId,
          input.worktreeId === undefined ? current.worktreeId : input.worktreeId,
          input.paneKey === undefined ? current.paneKey : input.paneKey,
          input.terminalHandle === undefined ? current.terminalHandle : input.terminalHandle,
          JSON.stringify(
            input.providerSession === undefined ? current.providerSession : input.providerSession
          ),
          input.processIncarnation === undefined
            ? current.processIncarnation
            : input.processIncarnation,
          input.terminalSurfaceVisible === undefined
            ? current.terminalSurfaceVisible
              ? 1
              : 0
            : input.terminalSurfaceVisible
              ? 1
              : 0,
          input.participation ?? current.participation,
          input.state ?? current.state,
          JSON.stringify(input.context ?? current.context),
          input.lastSeenAt === undefined ? current.lastSeenAt : input.lastSeenAt,
          now,
          id
        )
      const identity = input.identity?.trim()
      if (identity && identity !== current.identity) {
        this.renameReferences(current, identity)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.get(id)
  }

  remove(id: string): void {
    const participant = this.get(id)
    if (participant.actorKind === 'user') {
      throw new Error('room_user_participant_required')
    }
    this.db.prepare('DELETE FROM room_participants WHERE id = ?').run(id)
  }

  get(id: string): RoomParticipant {
    const row = this.db.prepare('SELECT * FROM room_participants WHERE id = ?').get(id) as
      | RoomRow
      | undefined
    if (!row) {
      throw new Error('room_participant_not_found')
    }
    return participantFromRow(row)
  }

  find(roomId: string, identity: string): RoomParticipant | null {
    const row = this.db
      .prepare('SELECT * FROM room_participants WHERE room_id = ? AND identity = ? COLLATE NOCASE')
      .get(roomId, identity) as RoomRow | undefined
    return row ? participantFromRow(row) : null
  }

  findByPaneKey(paneKey: string): RoomParticipant | null {
    return this.findOwner({ paneKey })
  }

  findByTerminalHandle(terminalHandle: string): RoomParticipant | null {
    return this.findOwner({ terminalHandle })
  }

  findOwner(input: RoomAgentOwnershipIdentity): RoomParticipant | null {
    return findRoomAgentOwner(this.db, input)
  }

  /** Hibernation uses communication timestamps only; bookkeeping updates are not activity. */
  listIdleAgents(idleBefore: number): RoomParticipant[] {
    return (
      this.db
        .prepare(
          `SELECT p.* FROM room_participants p
         WHERE p.actor_kind = 'agent' AND p.state = 'online'
           AND p.terminal_handle IS NOT NULL
           AND p.terminal_surface_visible = 0
           AND MAX(
             p.created_at,
             COALESCE((SELECT MAX(m.created_at) FROM room_messages m WHERE m.sender_id = p.id), 0),
             COALESCE((SELECT MAX(COALESCE(d.responded_at, d.delivered_at, 0))
               FROM room_deliveries d WHERE d.participant_id = p.id), 0)
           ) < ?
           AND NOT EXISTS (
             SELECT 1 FROM room_deliveries d WHERE d.participant_id = p.id AND (
               d.state IN ('pending', 'delivering') OR
               (d.state = 'delivered' AND d.responded_at IS NULL) OR
               (d.state = 'failed' AND d.error = 'room_delivery_uncertain') OR
               (d.state = 'suppressed' AND d.error = 'room_stopping')
             )
           )`
        )
        .all(idleBefore) as RoomRow[]
    ).map(participantFromRow)
  }

  listBound(roomId: string): RoomParticipant[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM room_participants WHERE room_id = ? AND actor_kind = 'agent'
         AND terminal_handle IS NOT NULL ORDER BY created_at`
        )
        .all(roomId) as RoomRow[]
    ).map(participantFromRow)
  }

  private renameReferences(participant: RoomParticipant, identity: string): void {
    this.db
      .prepare('UPDATE room_messages SET sender_identity = ? WHERE sender_id = ?')
      .run(identity, participant.id)
    this.db
      .prepare(
        'UPDATE OR REPLACE room_message_mentions SET identity = ? WHERE identity = ? COLLATE NOCASE'
      )
      .run(identity, participant.identity)
  }
}
