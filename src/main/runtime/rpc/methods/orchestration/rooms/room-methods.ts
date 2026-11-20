/* eslint-disable max-lines */
/**
 * Room RPC methods: CRUD for group chats and the entry point that sends a user
 * message into a room and runs the opening round of member prompts.
 */

import { randomUUID } from 'node:crypto'
import { getStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { defineMethod } from '../../../core'
import { runRoomRound, postRoomReply } from '../../../../orchestration/room-round'
import { ROOM_SOURCE, spawnRoomBot } from '../../../../orchestration/room-bot-spawn'
import { MAIN_BOT_NAME, MAIN_BOT_ROOM_NAME } from '../../../../orchestration/room-admin-tools'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { parseOrcaSessionAddress } from '../../../../../../shared/agent-session/identity/orca-session-address'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionPayloadFingerprint
} from '../../../../../../shared/agent-session/lifecycle/operations/structured-agent-session-mutation'
import { ensureRoomReplyWatcherForCurrentHost } from '../../../../orchestration/room-reply-watcher'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import {
  RoomBotCreateParams,
  RoomCreateParams,
  RoomDeleteParams,
  RoomEnsureMainBotParams,
  RoomListParams,
  RoomLogParams,
  RoomMemberAddParams,
  RoomMemberModelParams,
  RoomMemberRemoveParams,
  RoomPostParams,
  RoomSendParams,
  RoomShowParams
} from '../../../../../../shared/rpc-contract/orchestration-rooms-params'

const roomError = (code: string, message: string) => new OrchestrationError(code, message)

const exposeRoom = (room: {
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

const exposeRoomLine = (line: {
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
    const payload = line.payload ? (JSON.parse(line.payload) as unknown) : null
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

const exposeRoomLineOrNone = (line: Parameters<typeof exposeRoomLine>[0] | undefined) =>
  line ? exposeRoomLine(line) : null

/* eslint-disable max-lines */
/** A failed admin that never produced a normal room reply can be replaced safely. */
const adminNeedsRespawn = (
  db: ReturnType<OrcaRuntimeService['getOrchestrationDb']>,
  roomId: string,
  admin: { member_id: string; session_id: string | null; status: string }
): boolean => {
  const answered = (
    db.db
      .prepare(
        `SELECT COUNT(*) as n FROM room_log
         WHERE room_id = ? AND member_id = ? AND (kind IS NULL OR kind != 'failed')`
      )
      .get(roomId, admin.member_id) as { n: number }
  ).n
  return answered === 0 && admin.status !== 'working'
}

export const ORCHESTRATION_ROOM_METHODS = [
  defineMethod({
    name: 'orchestration.roomCreate',
    permission: 'workspace',
    params: RoomCreateParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const room = db.createRoom({
        name: params.name,
        mode: params.mode,
        notice: params.notice,
        worktree: params.worktree,
        members: params.members
      })
      return { room: exposeRoom(room) }
    }
  }),

  defineMethod({
    name: 'orchestration.roomList',
    permission: 'workspace',
    params: RoomListParams,
    handler: (_params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      return {
        rooms: db.listRooms().map((room) => ({
          ...exposeRoom(room),
          latestLine: exposeRoomLineOrNone(db.latestRoomLine(room.id))
        }))
      }
    }
  }),

  defineMethod({
    name: 'orchestration.roomShow',
    permission: 'workspace',
    params: RoomShowParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const room = params.id
        ? db.getRoom(params.id)
        : params.name
          ? db.getRoomByName(params.name)
          : undefined
      if (!room) {
        throw roomError('room_not_found', 'The room is not here.')
      }
      return { room: exposeRoom(room) }
    }
  }),

  defineMethod({
    name: 'orchestration.roomDelete',
    permission: 'workspace',
    params: RoomDeleteParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      db.deleteRoom(params.id)
      return { ok: true }
    }
  }),

  defineMethod({
    name: 'orchestration.roomMemberAdd',
    permission: 'workspace',
    params: RoomMemberAddParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      db.addRoomMember(params.id, {
        memberId: params.memberId,
        name: params.name,
        isAdmin: params.isAdmin
      })
      // Seating an existing chat still gets its own per-room cursor: without a
      // session_id the round runner would fall back to the member's main chat.
      // Point it at the seated session for now; a dedicated per-room session
      // can replace it later without changing the send path.
      try {
        db.setRoomMemberSession(params.id, params.memberId, params.memberId)
      } catch {
        // Member row wins; a missing session link just reuses the main chat.
      }
      const room = db.getRoom(params.id)
      if (!room) {
        throw roomError('room_not_found', 'The room is not here.')
      }
      return { room: exposeRoom(room) }
    }
  }),

  defineMethod({
    name: 'orchestration.roomBotCreate',
    permission: 'workspace',
    params: RoomBotCreateParams,
    handler: async (params, ctx) => {
      const db = ctx.runtime.getOrchestrationDb()
      const room = db.getRoom(params.id)
      if (!room) {
        throw roomError('room_not_found', 'The room is not here.')
      }
      const spawned = await spawnRoomBot({
        runtime: ctx.runtime,
        db,
        room,
        name: params.name,
        agent: params.agent,
        model: params.model,
        effort: params.effort,
        worktree: params.worktree,
        instructions: params.instructions,
        isAdmin: params.isAdmin,
        onSessionReady: () => ensureRoomReplyWatcherForCurrentHost(db, ctx.runtime)
      })
      const fresh = db.getRoom(room.id)
      return {
        memberId: spawned.memberId,
        sessionId: spawned.sessionId,
        room: fresh ? exposeRoom(fresh) : null
      }
    }
  }),

  defineMethod({
    name: 'orchestration.roomEnsureMainBot',
    permission: 'workspace',
    params: RoomEnsureMainBotParams,
    handler: async (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const roomName = params.roomName?.trim() || MAIN_BOT_ROOM_NAME
      const botName = params.botName?.trim() || MAIN_BOT_NAME
      const agent = params.agent?.trim() || 'codex'
      let room = db.getRoomByName(roomName)
      if (!room) {
        room = db.createRoom({
          name: roomName,
          mode: 'admin',
          notice: 'Orca HQ: talk to the admin to manage bots and group chats.',
          worktree: params.worktree
        })
      } else if (!room.worktree && params.worktree) {
        db.setRoomWorktree(room.id, params.worktree)
        const refilled = db.getRoom(room.id)
        if (refilled) {
          room = refilled
        }
      }
      // Repair an HQ whose first seat never produced a normal reply (missing CLI or
      // a rejected kickoff): keeping it turns HQ into a permanently silent room.
      let admin = room.members.find((m) => m.is_admin === 1)
      if (admin && adminNeedsRespawn(db, room.id, admin)) {
        try {
          db.removeRoomMember(room.id, admin.member_id)
          const refilled = db.getRoom(room.id)
          if (refilled) {
            room = refilled
          }
          admin = undefined
        } catch {
          // Repair is best-effort; a stale row just stays until next ensure.
        }
      }
      let adminSeated = room.members.some((m) => m.is_admin === 1)
      if (!adminSeated) {
        const worktree = room.worktree || params.worktree
        if (worktree) {
          try {
            await spawnRoomBot({
              runtime,
              db,
              room,
              name: botName,
              agent,
              model: params.model,
              effort: params.effort,
              worktree,
              isAdmin: true,
              instructions:
                'You were just set up as the user\u2019s Main Bot. Greet the user in one or two short messages: say you run their Bot team and group chats and they can ask you in plain words to create a bot or start a group. Then ask in one short question what the team should help with first. Write in Chinese.',
              onSessionReady: () => ensureRoomReplyWatcherForCurrentHost(db, runtime)
            })
            adminSeated = true
          } catch (error) {
            adminSeated = false
            db.appendRoomLine(room.id, {
              who: 'Orca',
              text: `Main Bot seat failed: ${error instanceof Error ? error.message : String(error)}`,
              kind: 'failed'
            })
          }
        }
      }
      ensureRoomReplyWatcherForCurrentHost(db, runtime)
      const fresh = db.getRoom(room.id)
      if (!fresh) {
        throw roomError('room_not_found', 'The room is not here.')
      }
      return { room: exposeRoom(fresh), adminSeated }
    }
  }),

  defineMethod({
    name: 'orchestration.roomMemberRemove',
    permission: 'workspace',
    params: RoomMemberRemoveParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      db.removeRoomMember(params.id, params.memberId)
      return { ok: true }
    }
  }),

  defineMethod({
    name: 'orchestration.roomMemberSetModel',
    permission: 'workspace',
    params: RoomMemberModelParams,
    handler: async (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const room = db.getRoom(params.id)
      const member = room?.members.find((m) => m.member_id === params.memberId)
      if (!room || !member) {
        throw roomError('room_member_not_found', 'The member is not in this room.')
      }
      const host = getStructuredAgentSessionHost()
      if (!host) {
        throw roomError('room_no_chat_host', 'The agent-session host is not running.')
      }
      const sessionId = parseOrcaSessionAddress(member.session_id ?? member.member_id)
      if (!sessionId) {
        throw roomError('room_member_no_session', 'This member has no model-enabled session.')
      }
      const fence = host.deps.store.getRecord(sessionId)?.lease.runtimeFence
      if (typeof fence !== 'number' || fence <= 0) {
        throw roomError('room_member_no_session', 'This member has no active session fence.')
      }
      const fields = { key: 'model', value: params.model }
      const result = await host.setOption(
        { callerKey: `room-model:${room.id}` },
        {
          envelope: {
            sessionId,
            clientOperationId: createStructuredAgentSessionOperationId(randomUUID),
            expectedRuntimeFence: fence,
            payloadFingerprint: structuredAgentSessionPayloadFingerprint({
              method: 'agentSession.setOption',
              sessionId,
              fields
            })
          },
          ...fields
        }
      )
      if (!result.ok) {
        throw roomError('room_member_model_refused', result.refusal.message ?? 'Model not applied.')
      }
      return { ok: true }
    }
  }),

  defineMethod({
    name: 'orchestration.roomSend',
    permission: 'workspace',
    params: RoomSendParams,
    handler: async (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const room = params.id
        ? db.getRoom(params.id)
        : params.name
          ? db.getRoomByName(params.name)
          : undefined
      if (!room) {
        throw roomError('room_not_found', 'The room is not here.')
      }
      const targetMember = params.targetMemberId
        ? room.members.find((m) => m.member_id === params.targetMemberId)
        : undefined
      if (params.targetMemberId && !targetMember) {
        throw roomError('room_member_not_found', 'The called member is not in this room.')
      }
      const host = getStructuredAgentSessionHost()
      if (!host) {
        throw roomError(
          'room_no_chat_host',
          'The agent-session host is not installed in this runtime.'
        )
      }
      ensureRoomReplyWatcherForCurrentHost(db, runtime)
      const result = await runRoomRound(
        room,
        {
          text: params.text,
          who: params.from ?? 'User',
          ...(params.targetMemberId ? { targetMemberId: params.targetMemberId } : {})
        },
        {
          db,
          host,
          callerKey: `room:${room.id}`,
          expectedRuntimeFenceFor: () => 0,
          fromSource: ROOM_SOURCE
        }
      )
      ensureRoomReplyWatcherForCurrentHost(db, runtime)
      return {
        seq: result.seq,
        slots: result.slots.map((s) => ({
          memberId: s.memberId,
          name: s.name,
          status: s.status,
          note: s.note
        }))
      }
    }
  }),

  defineMethod({
    name: 'orchestration.roomPost',
    permission: 'workspace',
    params: RoomPostParams,
    handler: async (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const room = db.getRoom(params.id)
      if (!room) {
        throw roomError('room_not_found', 'The room is not here.')
      }
      const host = getStructuredAgentSessionHost()
      if (!host) {
        throw roomError(
          'room_no_chat_host',
          'The agent-session host is not installed in this runtime.'
        )
      }
      ensureRoomReplyWatcherForCurrentHost(db, runtime)
      const result = await postRoomReply(room, params.memberId, params.text, {
        db,
        host,
        callerKey: `room:${room.id}`,
        expectedRuntimeFenceFor: () => 0,
        fromSource: ROOM_SOURCE
      })
      ensureRoomReplyWatcherForCurrentHost(db, runtime)
      return {
        seq: result.seq,
        followUps: result.followUps.map((m) => ({
          memberId: m.member_id,
          name: m.name
        }))
      }
    }
  }),

  defineMethod({
    name: 'orchestration.roomLog',
    permission: 'workspace',
    params: RoomLogParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const room = db.getRoom(params.id)
      if (!room) {
        throw roomError('room_not_found', 'The room is not here.')
      }
      const limit = params.limit ?? 60
      const lines = params.memberId
        ? db.unseenRoomLines(room.id, params.memberId, 200, limit)
        : (db.db
            .prepare(`SELECT * FROM room_log WHERE room_id = ? ORDER BY seq DESC LIMIT ?`)
            .all(room.id, limit)
            .toReversed() as {
            seq: number
            who: string
            member_id: string | null
            text: string
            kind: string | null
            payload: string | null
            created_at: string
          }[])
      return { room: exposeRoom(room), lines: lines.map(exposeRoomLine) }
    }
  })
]
