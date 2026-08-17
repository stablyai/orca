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

export class RoomParticipantStore {
  constructor(
    private readonly db: SyncDatabase.Database,
    private readonly readSessionOptions?: (
      sessionId: string
    ) => Readonly<Record<string, string>> | undefined
  ) {}

  private fromRow = (row: RoomRow): RoomParticipant => {
    const participant = participantFromRow(row)
    const session = participant.providerSession
    const options =
      session?.transport === 'machine' ? this.readSessionOptions?.(session.id) : undefined
    if (!options) {
      return participant
    }
    return {
      ...participant,
      context: {
        ...participant.context,
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {})
      }
    }
  }

  list(roomId: string): RoomParticipant[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM room_participants WHERE room_id = ? ORDER BY actor_kind = 'user' DESC, created_at"
        )
        .all(roomId) as RoomRow[]
    ).map(this.fromRow)
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
    this.db.exec('SAVEPOINT room_participant_update')
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
      this.db.exec('RELEASE room_participant_update')
    } catch (error) {
      this.db.exec('ROLLBACK TO room_participant_update')
      this.db.exec('RELEASE room_participant_update')
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
    return this.fromRow(row)
  }

  find(roomId: string, identity: string): RoomParticipant | null {
    const row = this.db
      .prepare('SELECT * FROM room_participants WHERE room_id = ? AND identity = ? COLLATE NOCASE')
      .get(roomId, identity) as RoomRow | undefined
    return row ? this.fromRow(row) : null
  }

  getUser(roomId: string): RoomParticipant {
    const user = this.list(roomId).find((participant) => participant.actorKind === 'user')
    if (!user) {
      throw new Error('room_user_participant_required')
    }
    return user
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
    ).map(this.fromRow)
  }

  listBound(roomId: string): RoomParticipant[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM room_participants WHERE room_id = ? AND actor_kind = 'agent'
         AND terminal_handle IS NOT NULL ORDER BY created_at`
        )
        .all(roomId) as RoomRow[]
    ).map(this.fromRow)
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
