import { randomUUID } from 'node:crypto'
import { getStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { defineMethod } from '../../../core'
import { spawnRoomBot } from '../../../../orchestration/room-bot-spawn'
import { MAIN_BOT_NAME, MAIN_BOT_ROOM_NAME } from '../../../../orchestration/room-admin-tools'
import { parseOrcaSessionAddress } from '../../../../../../shared/orca-session-address'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionPayloadFingerprint
} from '../../../../../../shared/structured-agent-session-mutation'
import { ensureRoomReplyWatcherForCurrentHost } from '../../../../orchestration/room-reply-watcher'
import {
  RoomBotCreateParams,
  RoomEnsureMainBotParams,
  RoomMemberModelParams
} from '../../../../../../shared/rpc-contract/orchestration-rooms-params'

import { roomError, exposeRoom, adminNeedsRespawn } from './room-presentation'

export const ORCHESTRATION_ROOM_BOT_METHODS = [
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
          const staleSessionId = parseOrcaSessionAddress(admin.session_id ?? admin.member_id)
          if (staleSessionId) {
            getStructuredAgentSessionHost()?.close(staleSessionId, 'evict').catch(() => undefined)
          }
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
                'You were just set up as the user\u2019s Main Bot. Greet the user in one or two short messages: say you run their Bot team and group chats and they can ask you in plain words to create a bot or start a group. Then ask in one short question what the team should help with first. Follow the user\u2019s preferred language.',
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
  })
]
