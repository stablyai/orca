import type { OrchestrationDb } from '../orchestration-db'
import type { RoomLogKind, RoomLogRow } from './room-store'

/** Append a line and advance the room's sequence. Returns the new seq. */
export function appendRoomLine(
  this: OrchestrationDb,
  roomId: string,
  line: {
    who: string
    memberId?: string | null
    text: string
    kind?: RoomLogKind
    payload?: string
  }
): number {
  const insert = this.db.prepare(
    `INSERT INTO room_log (room_id, seq, who, member_id, text, kind, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  const bump = this.db.prepare(`UPDATE rooms SET seq = ?, updated_at = ? WHERE id = ?`)
  let seq = 0
  this.db.exec('BEGIN IMMEDIATE')
  try {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The SELECT columns match the room schema created by migrations v44–46.
    const row = this.db.prepare(`SELECT seq FROM rooms WHERE id = ?`).get(roomId) as
      | { seq: number }
      | undefined
    if (!row) {
      throw Object.assign(new Error(`Room ${roomId} not found`), { code: 'room/invalid' })
    }
    seq = row.seq + 1
    const now = new Date().toISOString()
    insert.run(
      roomId,
      seq,
      line.who,
      line.memberId ?? null,
      line.text,
      line.kind ?? null,
      line.payload ?? null
    )
    bump.run(seq, now, roomId)
    this.db.exec('COMMIT')
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
  return seq
}

/** Unread lines for a member: everything above its cursor, excluding its own writes. */
export function unseenRoomLines(
  this: OrchestrationDb,
  roomId: string,
  memberId: string,
  firstLookCount = 12,
  deltaMax = 24
): RoomLogRow[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The SELECT columns match the room schema created by migrations v44–46.
  const member = this.db
    .prepare(`SELECT seen_seq FROM room_members WHERE room_id = ? AND member_id = ?`)
    .get(roomId, memberId) as { seen_seq: number } | undefined
  if (!member) {
    return []
  }
  if (member.seen_seq === 0) {
    // First look: pull the tail, still excluding the member's own writes.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The SELECT columns match the room schema created by migrations v44–46.
    return this.db
      .prepare(
        `SELECT * FROM room_log
         WHERE room_id = ? AND (member_id IS NULL OR member_id != ?)
         ORDER BY seq DESC LIMIT ?`
      )
      .all(roomId, memberId, firstLookCount)
      .toReversed() as RoomLogRow[]
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The SELECT columns match the room schema created by migrations v44–46.
  return this.db
    .prepare(
      `SELECT * FROM room_log
       WHERE room_id = ? AND seq > ? AND (member_id IS NULL OR member_id != ?)
       ORDER BY seq DESC LIMIT ?`
    )
    .all(roomId, member.seen_seq, memberId, deltaMax)
    .toReversed() as RoomLogRow[]
}
