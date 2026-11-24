/**
 * Room message methods: post a user message into a room and read the log back.
 */

import { getStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { defineMethod } from '../../../core'
import { runRoomRound, postRoomReply } from '../../../../orchestration/room-round'
import { ROOM_SOURCE } from '../../../../orchestration/room-bot-spawn'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { ensureRoomReplyWatcherForCurrentHost } from '../../../../orchestration/room-reply-watcher'
import { exposeRoom, exposeRoomLine } from './room-method-projection'
import {
  RoomLogParams,
  RoomPostParams,
  RoomSendParams
} from '../../../../../../shared/rpc-contract/orchestration-rooms-params'

export const ORCHESTRATION_ROOM_MESSAGE_METHODS = [
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
        throw new OrchestrationError('room_not_found', 'The room is not here.')
      }
      const targetMember = params.targetMemberId
        ? room.members.find((m) => m.member_id === params.targetMemberId)
        : undefined
      if (params.targetMemberId && !targetMember) {
        throw new OrchestrationError(
          'room_member_not_found',
          'The called member is not in this room.'
        )
      }
      const host = getStructuredAgentSessionHost()
      if (!host) {
        throw new OrchestrationError(
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
        throw new OrchestrationError('room_not_found', 'The room is not here.')
      }
      const host = getStructuredAgentSessionHost()
      if (!host) {
        throw new OrchestrationError(
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
        throw new OrchestrationError('room_not_found', 'The room is not here.')
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
