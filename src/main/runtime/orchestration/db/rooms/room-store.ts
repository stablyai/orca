/**
 * Room store: rooms, members, and the room transcript.
 *
 * A room is a group chat between the user and a set of agents. Agents keep their own
 * session per room (`session_id` on `room_members`), and share the room's ordered
 * `room_log`. `seen_seq` is each member's read cursor; unseen lines are what the
 * round runner hands to that member next turn.
 */

import { appendRoomLine, unseenRoomLines } from './room-transcript-store'
export { appendRoomLine, unseenRoomLines } from './room-transcript-store'
import { generateId } from '../generated-id'
import type { OrchestrationDb } from '../orchestration-db'

export type RoomMode = 'admin' | 'everyone'

export type RoomRow = {
  id: string
  name: string
  mode: RoomMode
  admin_member_id: string | null
  notice: string
  worktree: string
  seq: number
  created_at: string
  updated_at: string
}

export type RoomMemberRow = {
  room_id: string
  member_id: string
  name: string
  is_admin: number
  seen_seq: number
  session_id: string | null
  status: RoomMemberStatus
  status_updated_at: string
  created_at: string
}

export type RoomMemberStatus = 'idle' | 'working' | 'waiting' | 'failed'

export type RoomLogKind =
  | 'lookup'
  | 'resumed'
  | 'cut'
  | 'stopped'
  | 'done'
  | 'failed'
  | 'missed'
  | 'approval'

export type RoomLogRow = {
  room_id: string
  seq: number
  who: string
  member_id: string | null
  text: string
  kind: RoomLogKind | null
  payload: string | null
  created_at: string
}

export type RoomWithMembers = RoomRow & { members: RoomMemberRow[] }

const ROOM_MAX_MEMBERS = 12
const ROOM_NAME_MAX = 60
const ROOM_NOTICE_MAX = 2000

const invalid = (message: string) => Object.assign(new Error(message), { code: 'room/invalid' })

/** Mention syntax and roster addressing live on member names; keep them plain. */
export function roomMemberNameProblem(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) {
    return 'A member needs a name'
  }
  if (/[@`\r\n]/.test(trimmed) || /\b(all|everyone|user|you)\b/i.test(trimmed)) {
    return `Member name "${trimmed}" reads like a mention or role; pick another`
  }
  return null
}

export function createRoom(
  this: OrchestrationDb,
  input: {
    name: string
    mode?: RoomMode
    notice?: string
    worktree?: string
    members?: { memberId: string; name: string; isAdmin?: boolean }[]
  }
): RoomWithMembers {
  const name = String(input.name ?? '').trim()
  if (!name) {
    throw invalid('A room needs a name')
  }
  if (name.length > ROOM_NAME_MAX) {
    throw invalid(`Room name is over ${ROOM_NAME_MAX} characters`)
  }
  const notice = String(input.notice ?? '').slice(0, ROOM_NOTICE_MAX)
  const worktree = String(input.worktree ?? '')
  const mode: RoomMode = input.mode === 'everyone' ? 'everyone' : 'admin'
  const members = input.members ?? []
  if (members.length > ROOM_MAX_MEMBERS) {
    throw invalid(`A room has at most ${ROOM_MAX_MEMBERS} members`)
  }

  const id = generateId('room')
  const now = new Date().toISOString()
  const insertRoom = this.db.prepare(
    `INSERT INTO rooms (id, name, mode, admin_member_id, notice, worktree, seq, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, 0, ?, ?)`
  )
  const insertMember = this.db.prepare(
    `INSERT INTO room_members (room_id, member_id, name, is_admin, created_at)
     VALUES (?, ?, ?, ?, ?)`
  )
  const setAdmin = this.db.prepare(
    `UPDATE rooms SET admin_member_id = ?, updated_at = ? WHERE id = ?`
  )
  const namesSeen = new Set<string>()
  let adminMemberId: string | null = null

  this.db.exec('BEGIN IMMEDIATE')
  try {
    insertRoom.run(id, name, mode, notice, worktree, now, now)
    for (const member of members) {
      const memberName = String(member.name ?? '').trim()
      const problem = roomMemberNameProblem(memberName)
      if (problem) {
        throw invalid(problem)
      }
      const key = memberName.toLowerCase()
      if (namesSeen.has(key)) {
        throw invalid(`Duplicate member name "${memberName}"`)
      }
      namesSeen.add(key)
      const isAdmin = member.isAdmin ? 1 : 0
      insertMember.run(id, member.memberId, memberName, isAdmin, now)
      if (isAdmin && adminMemberId === null) {
        adminMemberId = member.memberId
      }
    }
    if (adminMemberId) {
      setAdmin.run(adminMemberId, now, id)
    }
    this.db.exec('COMMIT')
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
  return this.getRoom(id)!
}

export function getRoom(this: OrchestrationDb, roomId: string): RoomWithMembers | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The SELECT columns match the room schema created by migrations v44–46.
  const room = this.db.prepare(`SELECT * FROM rooms WHERE id = ?`).get(roomId) as
    | RoomRow
    | undefined
  if (!room) {
    return undefined
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The SELECT columns match the room schema created by migrations v44–46.
  const members = this.db
    .prepare(`SELECT * FROM room_members WHERE room_id = ? ORDER BY created_at, member_id`)
    .all(roomId) as RoomMemberRow[]
  return { ...room, members }
}

export function getRoomByName(this: OrchestrationDb, name: string): RoomWithMembers | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The SELECT columns match the room schema created by migrations v44–46.
  const room = this.db
    .prepare(`SELECT * FROM rooms WHERE lower(name) = lower(?)`)
    .get(String(name).trim()) as RoomRow | undefined
  if (!room) {
    return undefined
  }
  return this.getRoom(room.id)
}

export function listRooms(this: OrchestrationDb): RoomWithMembers[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The SELECT columns match the room schema created by migrations v44–46.
  const rows = this.db.prepare(`SELECT id FROM rooms ORDER BY created_at`).all() as { id: string }[]
  return rows.map((r) => this.getRoom(r.id)!).filter(Boolean)
}

/** Every room that carries this member, for reverse lookups (turn-completion watcher). */
export function roomsForMember(this: OrchestrationDb, memberId: string): RoomWithMembers[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The SELECT columns match the room schema created by migrations v44–46.
  const rows = this.db
    .prepare(`SELECT room_id FROM room_members WHERE member_id = ?`)
    .all(memberId) as { room_id: string }[]
  return rows.map((r) => this.getRoom(r.room_id)!).filter(Boolean)
}

export function latestRoomLine(this: OrchestrationDb, roomId: string): RoomLogRow | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The SELECT columns match the room schema created by migrations v44–46.
  return this.db
    .prepare(`SELECT * FROM room_log WHERE room_id = ? ORDER BY seq DESC LIMIT 1`)
    .get(roomId) as RoomLogRow | undefined
}

export function deleteRoom(this: OrchestrationDb, roomId: string): void {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    this.db.prepare(`DELETE FROM room_log WHERE room_id = ?`).run(roomId)
    this.db.prepare(`DELETE FROM room_members WHERE room_id = ?`).run(roomId)
    this.db.prepare(`DELETE FROM rooms WHERE id = ?`).run(roomId)
    this.db.exec('COMMIT')
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function addRoomMember(
  this: OrchestrationDb,
  roomId: string,
  member: { memberId: string; name: string; isAdmin?: boolean }
): void {
  const name = String(member.name ?? '').trim()
  const problem = roomMemberNameProblem(name)
  if (problem) {
    throw invalid(problem)
  }
  const room = this.getRoom(roomId)
  if (!room) {
    throw invalid(`Room ${roomId} not found`)
  }
  if (room.members.length >= ROOM_MAX_MEMBERS) {
    throw invalid(`A room has at most ${ROOM_MAX_MEMBERS} members`)
  }
  if (room.members.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
    throw invalid(`Duplicate member name "${name}"`)
  }
  const now = new Date().toISOString()
  this.db.exec('BEGIN IMMEDIATE')
  try {
    this.db
      .prepare(
        `INSERT INTO room_members (room_id, member_id, name, is_admin, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(roomId, member.memberId, name, member.isAdmin ? 1 : 0, now)
    if (member.isAdmin) {
      this.db
        .prepare(`UPDATE rooms SET admin_member_id = ?, updated_at = ? WHERE id = ?`)
        .run(member.memberId, now, roomId)
    }
    this.db.exec('COMMIT')
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function removeRoomMember(this: OrchestrationDb, roomId: string, memberId: string): void {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    this.db
      .prepare(`DELETE FROM room_members WHERE room_id = ? AND member_id = ?`)
      .run(roomId, memberId)
    this.db
      .prepare(
        `UPDATE rooms SET admin_member_id = NULL, updated_at = ?
         WHERE id = ? AND admin_member_id = ?`
      )
      .run(new Date().toISOString(), roomId, memberId)
    this.db.exec('COMMIT')
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function setRoomWorktree(this: OrchestrationDb, roomId: string, worktree: string): void {
  this.db
    .prepare(`UPDATE rooms SET worktree = ?, updated_at = ? WHERE id = ?`)
    .run(String(worktree ?? ''), new Date().toISOString(), roomId)
}

export function markRoomMemberSeen(
  this: OrchestrationDb,
  roomId: string,
  memberId: string,
  seq: number
): void {
  this.db
    .prepare(
      `UPDATE room_members SET seen_seq = MAX(seen_seq, ?) WHERE room_id = ? AND member_id = ?`
    )
    .run(seq, roomId, memberId)
}

export function setRoomMemberSession(
  this: OrchestrationDb,
  roomId: string,
  memberId: string,
  sessionId: string | null
): void {
  this.db
    .prepare(`UPDATE room_members SET session_id = ? WHERE room_id = ? AND member_id = ?`)
    .run(sessionId, roomId, memberId)
}

export function setRoomMemberStatus(
  this: OrchestrationDb,
  roomId: string,
  memberId: string,
  status: RoomMemberStatus
): void {
  this.db
    .prepare(
      `UPDATE room_members
       SET status = ?, status_updated_at = ?
       WHERE room_id = ? AND member_id = ?`
    )
    .run(status, new Date().toISOString(), roomId, memberId)
}

export type RoomStoreMethods = {
  createRoom: typeof createRoom
  getRoom: typeof getRoom
  getRoomByName: typeof getRoomByName
  listRooms: typeof listRooms
  roomsForMember: typeof roomsForMember
  latestRoomLine: typeof latestRoomLine
  deleteRoom: typeof deleteRoom
  addRoomMember: typeof addRoomMember
  removeRoomMember: typeof removeRoomMember
  setRoomWorktree: typeof setRoomWorktree
  markRoomMemberSeen: typeof markRoomMemberSeen
  setRoomMemberSession: typeof setRoomMemberSession
  setRoomMemberStatus: typeof setRoomMemberStatus
  appendRoomLine: typeof appendRoomLine
  unseenRoomLines: typeof unseenRoomLines
}

export function attachRoomStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    createRoom,
    getRoom,
    getRoomByName,
    listRooms,
    roomsForMember,
    latestRoomLine,
    deleteRoom,
    addRoomMember,
    removeRoomMember,
    setRoomWorktree,
    markRoomMemberSeen,
    setRoomMemberSession,
    setRoomMemberStatus,
    appendRoomLine,
    unseenRoomLines
  })
}
