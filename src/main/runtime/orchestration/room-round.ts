/**
 * Room round runner: one pass of the room's speaking order.
 *
 * A round starts when a user message posts to the room. Members speak one at a time,
 * in the order the round's slots put them: the room admin first in `admin` mode, the
 * whole roster in `everyone` mode, or only the members a message `@`-called. Each
 * member is sent a prompt containing the log lines it has not seen plus the round's
 * progress; its reply is delivered back into the room through a separate mailbox
 * path, which calls `runRoomRound` again on the reply to continue the round.
 *
 * Delivery goes through `sendAgentTurn`, which queues against a busy chat instead of
 * dropping the call, so a member whose own chat is working is reached without a
 * second channel.
 */

import { createHash } from 'node:crypto'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentMessageSource } from '../../../shared/agent-session/journal/agent-session-message-source'
import { parseOrcaSessionAddress } from '../../../shared/agent-session/identity/orca-session-address'
import { roomMentionsIn, type RoomMentionable } from '../../../shared/orchestration-room-mentions'
import type { OrchestrationDb } from './db/orchestration-db'
import type { RoomMemberRow, RoomWithMembers } from './db/rooms/room-store'
import { sendAgentTurn, type StructuredAgentTurnHost } from './turn-delivery/send-agent-turn'
import { escapeRegExp, roomPrompt, type RoomSlot } from './room-round-prompt'

export type { RoomSlot, RoomSlotStatus } from './room-round-prompt'

// How far past the seeded slots a round may still grow: each @-call the round adds
// costs one, so a member cannot ping-pong forever in one round.
const ROOM_EXTRA_TURNS = 4
const ROOM_ADMIN_EXTRA_TURNS = 4

const isPass = (text: string) =>
  text === '' ||
  // ASCII-only: brackets cover []() plus CJK variants via escapes.
  /^\s*[[\u3010(\uFF08]\s*pass\s*[\]\u3011)\uFF09]|^\s*pass\s*[.\u3002!\uFF01]?\s*$/i.test(text)

/** Models often echo the transcript's "Name: …" prefix; strip it before logging. */
export const stripRoomSpeakerName = (name: string, text: string) =>
  text.replace(new RegExp(`^\\s*\\**${escapeRegExp(name)}\\**\\s*[:：]\\s*`), '').trim()

function openingSpeakers(room: RoomWithMembers, text: string): RoomMemberRow[] {
  const mentionables: RoomMentionable[] = room.members.map((m) => ({
    id: m.member_id,
    name: m.name
  }))
  const { all, found } = roomMentionsIn(text, mentionables)
  if (all) {
    return room.members
  }
  if (found.length > 0) {
    const ids = new Set(found.map((f) => f.id))
    return room.members.filter((m) => ids.has(m.member_id))
  }
  if (room.mode === 'admin' && room.admin_member_id) {
    const admin = room.members.find((m) => m.member_id === room.admin_member_id)
    return admin ? [admin] : []
  }
  if (room.mode === 'admin') {
    // Older rooms can carry an admin row before `rooms.admin_member_id` was filled.
    const admin = room.members.find((m) => m.is_admin === 1)
    return admin ? [admin] : []
  }
  // everyone mode with no @-mentions: the whole roster in roster order.
  return room.members
}

function roomOperationId(roundId: string, memberId: string, seq: number): string {
  const digest = createHash('sha256')
    .update(`${roundId}:${memberId}:${seq}`)
    .digest('hex')
    .slice(0, 32)
  return `${String(Date.now()).padStart(13, '0')}-${digest}`
}

export type RoomSendOutcome =
  | { kind: 'sent' }
  | { kind: 'queued' }
  | { kind: 'refused'; message: string }
  | { kind: 'failed'; code: string; message: string }

/** Send a member's prompt into its own chat. Reply text is not waited for here: a
 *  member's answer arrives through the room mailbox and a later `runRoomRound` call
 *  posts it. */
export async function sendRoomTurn(args: {
  member: RoomMemberRow
  host: StructuredAgentTurnHost
  callerKey: string
  expectedRuntimeFence: number
  prompt: string
  fromSource?: AgentMessageSource
  signal?: AbortSignal
  budgetMs?: number
}): Promise<RoomSendOutcome> {
  // A member's room session (`session_id`) wins over its own chat session
  // (`member_id`): a spawned bot gets its own conversation per room.
  const sessionId = parseOrcaSessionAddress(args.member.session_id ?? args.member.member_id)
  if (!sessionId) {
    return {
      kind: 'failed',
      code: 'ADDRESS',
      message: `Member ${args.member.name} has no structured session address.`
    }
  }
  if (args.signal?.aborted) {
    return { kind: 'failed', code: 'ABORTED', message: 'stopped' }
  }

  const body: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: args.prompt }],
    ...(args.fromSource ? { from: args.fromSource } : {})
  }
  const outcome = await sendAgentTurn({
    kind: 'structured-session',
    host: args.host,
    sessionId,
    callerKey: args.callerKey,
    turn: {
      body,
      delivery: 'queue',
      operationId: roomOperationId(args.callerKey, args.member.member_id, Date.now()),
      expectedRuntimeFence: args.expectedRuntimeFence
    },
    budgetMs: args.budgetMs
  })
  switch (outcome.kind) {
    case 'refused':
      return { kind: 'refused', message: outcome.refusal.message }
    case 'queued':
      return { kind: 'queued' }
    case 'sent':
      return { kind: 'sent' }
    default:
      return { kind: 'failed', code: 'UNKNOWN', message: 'unknown send outcome' }
  }
}

export type RoomRoundDeps = {
  db: OrchestrationDb
  host: StructuredAgentTurnHost
  callerKey: string
  expectedRuntimeFenceFor: (memberId: string) => number
  fromSource?: AgentMessageSource
  signal?: AbortSignal
}

/**
 * Post `text` into the room log from `who`, and deliver prompts to the members the
 * round's opening calls for. Returns the slots with their delivery status so a
 * caller can render or track progress.
 */
export async function runRoomRound(
  room: RoomWithMembers,
  trigger: {
    text: string
    who?: string
    memberId?: string | null
    targetMemberId?: string
  },
  deps: RoomRoundDeps
): Promise<{ seq: number; slots: RoomSlot[] }> {
  const { db, host } = deps
  const targetMember = trigger.targetMemberId
    ? room.members.find((m) => m.member_id === trigger.targetMemberId)
    : undefined
  const opening = targetMember ? [targetMember] : openingSpeakers(room, trigger.text)
  const startSeq = db.appendRoomLine(room.id, {
    who: trigger.who ?? 'User',
    memberId: trigger.memberId ?? null,
    text: trigger.text,
    ...(targetMember ? { payload: JSON.stringify({ targetMemberId: targetMember.member_id }) } : {})
  })

  const slots: RoomSlot[] = opening.map((m) => ({
    memberId: m.member_id,
    name: m.name,
    status: 'waiting'
  }))
  const turns = new Map<string, number>()
  const turnBudget =
    opening.length + ROOM_EXTRA_TURNS + (room.admin_member_id ? ROOM_ADMIN_EXTRA_TURNS : 0)

  let spent = 0
  for (let index = 0; index < slots.length; index += 1) {
    if (deps.signal?.aborted) {
      break
    }
    if (spent >= turnBudget) {
      break
    }
    const slot = slots[index]
    const member = room.members.find((m) => m.member_id === slot.memberId)
    if (!member) {
      slot.status = 'left'
      continue
    }
    slot.status = 'speaking'
    spent += 1
    turns.set(member.member_id, (turns.get(member.member_id) ?? 0) + 1)

    const unseen = db.unseenRoomLines(room.id, member.member_id)
    db.markRoomMemberSeen(room.id, member.member_id, startSeq)
    const prompt = roomPrompt(room, member, { slots, startSeq }, unseen)

    const sent = await sendRoomTurn({
      member,
      host,
      callerKey: deps.callerKey,
      expectedRuntimeFence: deps.expectedRuntimeFenceFor(member.member_id),
      prompt,
      fromSource: deps.fromSource,
      signal: deps.signal
    })

    switch (sent.kind) {
      case 'sent':
        deps.db.setRoomMemberStatus(room.id, member.member_id, 'working')
        slot.status = 'speaking' // still speaking; reply comes back through the room mailbox
        break
      case 'queued':
        // Busy chat holds our prompt as a draft: surface it as working so the
        // room shows "it is working" instead of silently looking idle.
        slot.status = 'working'
        deps.db.setRoomMemberStatus(room.id, member.member_id, 'working')
        break
      case 'refused':
      case 'failed':
        slot.status = 'failed'
        deps.db.setRoomMemberStatus(room.id, member.member_id, 'failed')
        db.appendRoomLine(room.id, {
          who: member.name,
          memberId: member.member_id,
          text: sent.message,
          kind: 'failed'
        })
        break
    }
  }

  return { seq: startSeq, slots }
}

/**
 * Post a member's reply into the room log and queue the next round of `@`-calls it
 * made. Only the admin's `@all` fans out; a member's own `@all` stays a name call.
 */
export async function postRoomReply(
  room: RoomWithMembers,
  memberId: string,
  text: string,
  deps: RoomRoundDeps
): Promise<{ seq: number; followUps: RoomMemberRow[] }> {
  const member = room.members.find((m) => m.member_id === memberId)
  if (!member) {
    throw new Error(`Member ${memberId} is not in room ${room.id}`)
  }
  const stripped = stripRoomSpeakerName(member.name, text.trim())
  deps.db.setRoomMemberStatus(room.id, memberId, 'idle')
  if (isPass(stripped)) {
    return { seq: room.seq, followUps: [] }
  }
  const seq = deps.db.appendRoomLine(room.id, {
    who: member.name,
    memberId: member.member_id,
    text: stripped
  })
  const mentionables: RoomMentionable[] = room.members.map((m) => ({
    id: m.member_id,
    name: m.name
  }))
  const leads = member.member_id === room.admin_member_id
  const { all, found } = roomMentionsIn(stripped, mentionables, { speakerId: memberId })
  const namedIds = new Set(found.map((f) => f.id))
  const callees =
    leads && all
      ? room.members.filter((m) => m.member_id !== memberId)
      : room.members.filter((m) => namedIds.has(m.member_id))
  return { seq, followUps: callees }
}
