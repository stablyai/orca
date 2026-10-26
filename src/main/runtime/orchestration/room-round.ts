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
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { AgentMessageSource } from '../../../shared/agent-session/agent-session-message-source'
import { parseOrcaSessionAddress } from '../../../shared/orca-session-address'
import { roomMentionsIn, type RoomMentionable } from '../../../shared/orchestration-room-mentions'
import type { OrchestrationDb } from './db'
import type { RoomLogRow, RoomMemberRow, RoomWithMembers } from './db/rooms/room-store'
import { sendAgentTurn, type StructuredAgentTurnHost } from './send-agent-turn'

export type RoomSlotStatus =
  | 'waiting'
  | 'speaking'
  | 'posted'
  | 'passed'
  | 'missed'
  | 'working'
  | 'failed'
  | 'left'

export type RoomSlot = {
  memberId: string
  name: string
  status: RoomSlotStatus
  note?: string
  calledBy?: string
}

// How far past the seeded slots a round may still grow: each @-call the round adds
// costs one, so a member cannot ping-pong forever in one round.
const ROOM_EXTRA_TURNS = 4
const ROOM_ADMIN_EXTRA_TURNS = 4
const ROOM_EARLIER_MAX = 8
const GROUP_LINE_READ = 20_000

const ROOM_REPLY_TEXT =
  'Reply with your message for the group, no name prefix: in a discussion, one or two short messages. When you are asked to do something, do it now with your tools. The group does not wait for you and sees what you write while you work: say what you will do, write again only when something matters, and end with the result, never a promise to do it later. Reply [PASS] to stay silent when you have nothing new to add or the message is for someone else.'

const ROOM_CALLS_TEXT =
  'Writing "@Name" calls that member next, to answer or to do what you ask; when it finishes work you gave it, you answer its result. To only mention a member, write its name without "@".'

const isPass = (text: string) =>
  text === '' ||
  // ASCII-only: brackets cover []() plus CJK variants via escapes.
  /^\s*[[\u3010(\uFF08]\s*pass\s*[\]\u3011)\uFF09]|^\s*pass\s*[.\u3002!\uFF01]?\s*$/i.test(text)
export { isPass as roomReplyIsPass }

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Models often echo the transcript's "Name: …" prefix; strip it before logging. */
export const stripRoomSpeakerName = (name: string, text: string) =>
  text.replace(new RegExp(`^\\s*\\**${escapeRegExp(name)}\\**\\s*[:：]\\s*`), '').trim()

function slotLabel(slot: RoomSlot): string {
  switch (slot.status) {
    case 'speaking':
      return `${slot.name} (you, now)`
    case 'posted':
      return `${slot.name} (posted)`
    case 'passed':
      return `${slot.name} (passed)`
    case 'missed':
      return `${slot.name} (no answer)`
    case 'working':
      return `${slot.name} (working on it; posts when done)`
    case 'failed':
      return `${slot.name} (could not answer: error)`
    case 'left':
      return `${slot.name} (left the group)`
    case 'waiting':
      return slot.name
  }
}

const transcript = (lines: RoomLogRow[]): string =>
  lines.map((line) => `${line.who}: ${line.text.slice(0, GROUP_LINE_READ)}`).join('\n')

function roomPrompt(
  room: RoomWithMembers,
  member: RoomMemberRow,
  round: { slots: RoomSlot[]; startSeq: number },
  unseen: RoomLogRow[]
): string {
  const peers = room.members
    .filter((m) => m.member_id !== member.member_id)
    .map((m) => `${m.name}${m.member_id === room.admin_member_id ? ' (admin)' : ''}`)
  const leads = member.member_id === room.admin_member_id
  const earlier = unseen.filter((l) => l.seq < round.startSeq).slice(-ROOM_EARLIER_MAX)
  const current = unseen.filter((l) => l.seq >= round.startSeq)
  const index = round.slots.findIndex((s) => s.status === 'speaking')
  const before = Math.max(0, index)
  const after = index === -1 ? 0 : round.slots.length - index - 1

  const parts = [
    `Members: the user${peers.length ? `, ${peers.join(', ')}` : ''} and you${leads ? ' (admin)' : ''}. Members speak one at a time; each message is posted before the next speaker starts. ${ROOM_CALLS_TEXT}`,
    room.notice ? `Group notice (shared instructions for every member):\n${room.notice}` : '',
    leads
      ? room.mode === 'admin'
        ? 'You are this group\'s admin. Plain messages come to you first: answer them, or call the members who should answer with @Name. "@all" calls every member.'
        : 'You are this group\'s admin. "@all" calls every member.'
      : '',
    earlier.length
      ? `Earlier in the group, before this round (context only):\n${transcript(earlier)}`
      : '',
    current.length
      ? `This round so far (oldest first):\n${transcript(current)}`
      : 'Nothing new in this round since your last message.',
    `Speaking order for this round: ${round.slots.map(slotLabel).join(' → ')}.`,
    `You are number ${index + 1} of ${round.slots.length}. ${before === 0 ? 'Nobody spoke before you' : `${before} went before you`}${after === 0 ? ', and you are the last.' : `; ${after} after you will see your message.`}`,
    ROOM_REPLY_TEXT
  ].filter(Boolean)
  return parts.join('\n\n')
}

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
        slot.status = 'working' // reply comes back through the room mailbox
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
): Promise<{ seq: number; followUps: RoomMemberRow[]; passed: boolean }> {
  const member = room.members.find((m) => m.member_id === memberId)
  if (!member) {
    throw new Error(`Member ${memberId} is not in room ${room.id}`)
  }
  const stripped = stripRoomSpeakerName(member.name, text.trim())
  deps.db.setRoomMemberStatus(room.id, memberId, 'idle')
  if (isPass(stripped)) {
    return { seq: room.seq, followUps: [], passed: true }
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
  return { seq, followUps: callees, passed: false }
}
