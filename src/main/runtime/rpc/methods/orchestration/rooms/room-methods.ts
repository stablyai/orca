/**
 * Room RPC methods: CRUD for group chats and the entry point that sends a user
 * message into a room and runs the opening round of member prompts.
 */

import { randomUUID } from 'node:crypto'
import { getStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { defineMethod } from '../../../core'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { parseOrcaSessionAddress } from '../../../../../../shared/agent-session/identity/orca-session-address'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionPayloadFingerprint
} from '../../../../../../shared/agent-session/lifecycle/operations/structured-agent-session-mutation'
import { exposeRoom, exposeRoomLineOrNone } from './room-method-projection'
import { ORCHESTRATION_ROOM_BOT_METHODS } from './room-bot-methods'
import { ORCHESTRATION_ROOM_MESSAGE_METHODS } from './room-message-methods'
import {
  RoomCreateParams,
  RoomDeleteParams,
  RoomListParams,
  RoomMemberAddParams,
  RoomMemberModelParams,
  RoomMemberRemoveParams,
  RoomShowParams
} from '../../../../../../shared/rpc-contract/orchestration-rooms-params'

const roomError = (code: string, message: string) => new OrchestrationError(code, message)

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

  ...ORCHESTRATION_ROOM_BOT_METHODS,

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

  ...ORCHESTRATION_ROOM_MESSAGE_METHODS
]
