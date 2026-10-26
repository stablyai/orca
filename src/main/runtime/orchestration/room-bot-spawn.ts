import { randomUUID } from 'node:crypto'
import type { AgentMessageSource } from '../../../shared/agent-session/agent-session-message-source'
import { formatOrcaSessionAddress, isOrcaSessionId } from '../../../shared/orca-session-address'
import { createStructuredAgentSessionId } from '../../../shared/structured-agent-session-create'
import { createStructuredAgentSessionOperationId } from '../../../shared/structured-agent-session-mutation'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../orca-runtime'
import { createStructuredAgentSessionForWorktree } from '../rpc/methods/structured-agent-session-create'
import type { OrchestrationDb } from './db'
import type { RoomWithMembers } from './db/rooms/room-store'
import { OrchestrationError } from './orchestration-error'
import { MAIN_BOT_INSTRUCTIONS, MAIN_BOT_TOOL_DOC } from './room-admin-tools'
import { sendRoomTurn } from './room-round'

// A room prompt reaches a member as Orca speaking for the group, not as the person
// at the member's own composer.
export const ROOM_SOURCE: AgentMessageSource = { kind: 'agent', senders: [], orchestration: null }

const roomError = (code: string, message: string) => new OrchestrationError(code, message)

/** Mint an at-rest structured session, seat it as a room member, and brief it. */
export async function spawnRoomBot(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  room: RoomWithMembers
  name: string
  agent: string
  model?: string
  effort?: string
  worktree: string
  instructions?: string
  isAdmin?: boolean
  callerKey?: string
  /** Install room reply plumbing while the new host exists but before its first turn. */
  onSessionReady?: () => void
}): Promise<{ memberId: string; sessionId: string }> {
  const callerKey = args.callerKey ?? `room-bot:${args.room.id}`
  // Every admin seats with the tool doc so plain words ("make a group with
  // Claude") work; a custom brief stays and the doc is appended to it.
  const brief = args.isAdmin
    ? args.instructions?.trim()
      ? `${args.instructions.trim()}\n${MAIN_BOT_TOOL_DOC}`
      : MAIN_BOT_INSTRUCTIONS
    : args.instructions?.trim()
  const sessionId = createStructuredAgentSessionId(args.agent, randomUUID)
  const created = await createStructuredAgentSessionForWorktree({
    runtime: args.runtime,
    ensureHost: async () => {
      await args.runtime.ensureStructuredAgentSessionHost()
      const host = getStructuredAgentSessionHost()
      if (!host) {
        throw roomError('room_no_chat_host', 'The agent-session host is not installed.')
      }
      return host
    },
    caller: { callerKey },
    envelope: {
      sessionId,
      clientOperationId: createStructuredAgentSessionOperationId(randomUUID),
      expectedRuntimeFence: null,
      payloadFingerprint: ''
    },
    worktree: args.worktree,
    agent: args.agent,
    ...(args.model || args.effort
      ? {
          options: {
            ...(args.model ? { model: args.model } : {}),
            ...(args.effort ? { effort: args.effort } : {})
          }
        }
      : {}),
    atRest: true,
    activate: false
  })
  if (!created.ok) {
    throw roomError('room_bot_refused', `The bot's session was refused: ${created.refusal.message}`)
  }
  if (!isOrcaSessionId(sessionId)) {
    throw roomError('room_bot_refused', 'The bot session id came out malformed.')
  }
  args.onSessionReady?.()
  const memberAddress = formatOrcaSessionAddress(sessionId)
  args.db.addRoomMember(args.room.id, {
    memberId: memberAddress,
    name: args.name,
    isAdmin: args.isAdmin
  })
  // member_id and session_id coincide for a spawned bot: its whole conversation IS the room session.
  args.db.setRoomMemberSession(args.room.id, memberAddress, memberAddress)
  const host = getStructuredAgentSessionHost()
  const member = args.db.getRoom(args.room.id)?.members.find((m) => m.member_id === memberAddress)
  if (host && member && brief) {
    try {
      const sent = await sendRoomTurn({
        member,
        host,
        callerKey,
        expectedRuntimeFence: 0,
        prompt: brief,
        fromSource: ROOM_SOURCE
      })
      if (sent.kind === 'sent' || sent.kind === 'queued') {
        args.db.setRoomMemberStatus(args.room.id, memberAddress, 'working')
      } else {
        console.warn(
          `[rooms] kickoff turn not delivered to ${args.name}: ${sent.kind === 'refused' ? sent.message : sent.message}`
        )
        args.db.appendRoomLine(args.room.id, {
          who: args.name,
          memberId: memberAddress,
          text: `Kickoff not delivered (${sent.kind}): ${sent.kind === 'refused' ? sent.message : sent.message}`,
          kind: 'failed'
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[rooms] kickoff turn threw for ${args.name}: ${message}`)
      args.db.appendRoomLine(args.room.id, {
        who: args.name,
        memberId: memberAddress,
        text: `Kickoff failed: ${message}`,
        kind: 'failed'
      })
      args.db.setRoomMemberStatus(args.room.id, memberAddress, 'failed')
    }
  }
  return { memberId: memberAddress, sessionId }
}
