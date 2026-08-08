import { randomUUID } from 'node:crypto'
import type SyncDatabase from '../../sqlite/sync-database'
import { EMPTY_ROOM_CONTEXT, type Room, type RoomRole } from '../../../shared/rooms'
import { roleFromRow, roomFromRow, type RoomRow } from './rows'
import { ROOM_ROLE_PRESETS } from './role-presets'

export class RoomCoreStore {
  constructor(private readonly db: SyncDatabase.Database) {}

  create(input: {
    id?: string
    projectId: string
    worktreeId?: string | null
    name: string
    description?: string
    userIdentity?: string
    userDisplayName?: string
  }): Room {
    const roomId = input.id ?? randomUUID()
    const now = Date.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(
          'INSERT INTO rooms (id, project_id, worktree_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          roomId,
          input.projectId,
          input.worktreeId ?? null,
          input.name.trim(),
          input.description?.trim() ?? '',
          now,
          now
        )
      this.db
        .prepare(
          `INSERT INTO room_participants
           (id, room_id, identity, display_name, actor_kind, context_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'user', ?, ?, ?)`
        )
        .run(
          randomUUID(),
          roomId,
          input.userIdentity?.trim() || 'user',
          input.userDisplayName?.trim() || 'You',
          JSON.stringify(EMPTY_ROOM_CONTEXT),
          now,
          now
        )
      const insertRole = this.db.prepare(
        `INSERT INTO room_roles
         (id, room_id, name, prompt, is_preset, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`
      )
      for (const role of ROOM_ROLE_PRESETS) {
        insertRole.run(randomUUID(), roomId, role.name, role.prompt, now, now)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.get(roomId)
  }

  list(projectId: string, includeArchived = false): Room[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM rooms WHERE project_id = ? AND (? = 1 OR archived_at IS NULL)
         ORDER BY updated_at DESC, created_at DESC`
        )
        .all(projectId, includeArchived ? 1 : 0) as RoomRow[]
    ).map(roomFromRow)
  }

  get(id: string): Room {
    const row = this.db.prepare('SELECT * FROM rooms WHERE id = ?').get(id) as RoomRow | undefined
    if (!row) {
      throw new Error('room_not_found')
    }
    return roomFromRow(row)
  }

  update(
    id: string,
    input: {
      name?: string
      description?: string
      loopLimit?: number
      archived?: boolean
      worktreeId?: string | null
    }
  ): Room {
    const room = this.get(id)
    const now = Date.now()
    this.db
      .prepare(
        `UPDATE rooms SET name = ?, description = ?, loop_limit = ?, archived_at = ?, worktree_id = ?,
         updated_at = ? WHERE id = ?`
      )
      .run(
        input.name?.trim() ?? room.name,
        input.description?.trim() ?? room.description,
        input.loopLimit ?? room.loopLimit,
        input.archived === undefined ? room.archivedAt : input.archived ? now : null,
        input.worktreeId === undefined ? room.worktreeId : input.worktreeId,
        now,
        id
      )
    return this.get(id)
  }

  listRoles(roomId: string): RoomRole[] {
    return (
      this.db
        .prepare('SELECT * FROM room_roles WHERE room_id = ? ORDER BY is_preset DESC, name')
        .all(roomId) as RoomRow[]
    ).map(roleFromRow)
  }

  saveRole(input: { id?: string; roomId: string; name: string; prompt: string }): RoomRole {
    const id = input.id ?? randomUUID()
    if (input.id) {
      const existing = this.getRole(input.id)
      if (existing.roomId !== input.roomId) {
        throw new Error('room_role_not_found')
      }
    }
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO room_roles (id, room_id, name, prompt, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, prompt = excluded.prompt,
           updated_at = excluded.updated_at WHERE room_roles.room_id = excluded.room_id`
      )
      .run(id, input.roomId, input.name.trim(), input.prompt.trim(), now, now)
    return this.getRole(id)
  }

  deleteRole(id: string): void {
    if (this.db.prepare('DELETE FROM room_roles WHERE id = ?').run(id).changes === 0) {
      throw new Error('room_role_not_found')
    }
  }

  getRole(id: string): RoomRole {
    const row = this.db.prepare('SELECT * FROM room_roles WHERE id = ?').get(id) as
      | RoomRow
      | undefined
    if (!row) {
      throw new Error('room_role_not_found')
    }
    return roleFromRow(row)
  }
}
