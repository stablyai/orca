import { getStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { defineMethod } from '../../../core'
import { runRoomRound, postRoomReply } from '../../../../orchestration/room-round'
import { ROOM_SOURCE } from '../../../../orchestration/room-bot-spawn'
import {
  ensureRoomReplyWatcherForCurrentHost,
  resetRoomWatchBudget
} from '../../../../orchestration/room-reply-watcher'
import {
  RoomCreateParams,
  RoomDeleteParams,
  RoomListParams,
  RoomLogParams,
  RoomMemberAddParams,
  RoomMemberRemoveParams,
  RoomPostParams,
  RoomSendParams,
  RoomShowParams
} from '../../../../../../shared/rpc-contract/orchestration-rooms-params'

import { roomError, exposeRoom, exposeRoomLine, exposeRoomLineOrNone } from './room-presentation'
import { ORCHESTRATION_ROOM_BOT_METHODS } from './room-bot-methods'

export const ORCHESTRATION_ROOM_METHODS = [
  ...ORCHESTRATION_ROOM_BOT_METHODS,
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
      resetRoomWatchBudget(db, room.id)
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
        : // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The SELECT columns match the room schema created by migrations v44–46.
          (db.db
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
