import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { OrcaRuntimeService } from '../../../../orca-runtime'

export const roomError = (code: string, message: string) => new OrchestrationError(code, message)

export const exposeRoom = (room: {
  id: string
  name: string
  mode: string
  admin_member_id: string | null
  notice: string
  worktree: string
  seq: number
  created_at: string
  updated_at: string
  members: {
    member_id: string
    name: string
    is_admin: number
    seen_seq: number
    session_id: string | null
    status: string
    status_updated_at: string
  }[]
}) => ({
  id: room.id,
  name: room.name,
  mode: room.mode,
  adminMemberId: room.admin_member_id,
  notice: room.notice,
  worktree: room.worktree,
  seq: room.seq,
  createdAt: room.created_at,
  updatedAt: room.updated_at,
  members: room.members.map((m) => ({
    memberId: m.member_id,
    name: m.name,
    isAdmin: m.is_admin === 1,
    seenSeq: m.seen_seq,
    sessionId: m.session_id,
    status: m.status,
    statusUpdatedAt: m.status_updated_at
  }))
})

export const exposeRoomLine = (line: {
  seq: number
  who: string
  member_id: string | null
  text: string
  kind: string | null
  payload?: string | null
  created_at: string
}) => {
  let targetMemberId: string | null = null
  try {
    const payload: unknown = line.payload ? JSON.parse(line.payload) : null
    if (
      payload &&
      typeof payload === 'object' &&
      'targetMemberId' in payload &&
      typeof payload.targetMemberId === 'string'
    ) {
      targetMemberId = payload.targetMemberId
    }
  } catch {
    // Legacy payloads are opaque transport data.
  }
  return {
    seq: line.seq,
    who: line.who,
    memberId: line.member_id,
    text: line.text,
    kind: line.kind,
    targetMemberId,
    createdAt: line.created_at
  }
}

export const exposeRoomLineOrNone = (line: Parameters<typeof exposeRoomLine>[0] | undefined) =>
  line ? exposeRoomLine(line) : null

/** A failed admin that never produced a normal room reply can be replaced safely. */
export const adminNeedsRespawn = (
  db: ReturnType<OrcaRuntimeService['getOrchestrationDb']>,
  roomId: string,
  admin: { member_id: string; session_id: string | null; status: string }
): boolean => {
  const answered = db.db
    .prepare(
      `SELECT COUNT(*) as n FROM room_log
         WHERE room_id = ? AND member_id = ? AND (kind IS NULL OR kind != 'failed')`
    )
    .get(roomId, admin.member_id)?.n
  return answered === 0 && admin.status !== 'working'
}
