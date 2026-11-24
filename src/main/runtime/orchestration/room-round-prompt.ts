import type { RoomLogRow, RoomMemberRow, RoomWithMembers } from './db/rooms/room-store'

/** Round prompt: the per-member message text for one pass of the speaking order. Pure text assembly; delivery lives in room-round. */

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

const ROOM_EARLIER_MAX = 8
const GROUP_LINE_READ = 20_000

const ROOM_REPLY_TEXT =
  'Reply with your message for the group, no name prefix: in a discussion, one or two short messages. When you are asked to do something, do it now with your tools. The group does not wait for you and sees what you write while you work: say what you will do, write again only when something matters, and end with the result, never a promise to do it later. Reply [PASS] to stay silent when you have nothing new to add or the message is for someone else.'

const ROOM_CALLS_TEXT =
  'Writing "@Name" calls that member next, to answer or to do what you ask; when it finishes work you gave it, you answer its result. To only mention a member, write its name without "@".'

const headOf = (text: string, n: number) => (text.length > n ? text.slice(0, n) : text)

export const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

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
    default:
      return slot.name
  }
}

const transcript = (lines: RoomLogRow[]): string =>
  lines.map((line) => `${line.who}: ${headOf(line.text, GROUP_LINE_READ)}`).join('\n')

export function roomPrompt(
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
