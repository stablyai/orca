import { AGENT_CONVERSATION_REFUSAL_CODES as CODES } from '../../../shared/agent-conversations/agent-conversation-contracts'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { AgentConversationRefusal } from './agent-conversation-refusal'
import {
  isAgentReadPartialRow,
  type AgentReadPartialRow
} from '../../native-chat/agent-session-wire/publication/history/agent-read-row-progress'
import { isRecord } from '../../../shared/agent-status/child-work/agent-status-child-work-value-guards'

/** Chat cursors are version 2; transcript cursors stay version 1. */
const PREFIXES = { 1: 'oar1_', 2: 'oar2_' } as const

/** Where the next `orca agent read` continues, pinned to one agent and one source. */
export type ReadCursor =
  /** `partial`: the next journal row, when part of it was read. */
  | {
      v: 2
      id: string
      s: 'chat'
      session: string
      journal: AgentJournalCursor
      partial?: AgentReadPartialRow
    }
  | { v: 1; id: string; s: 'transcript'; i: string; p: number; c?: string }

export function encodeReadCursor(cursor: ReadCursor): string {
  return `${PREFIXES[cursor.v]}${Buffer.from(JSON.stringify(cursor)).toString('base64url')}`
}

export function decodeReadCursor(value: string, orcaSessionId: string): ReadCursor {
  const version = value.startsWith(PREFIXES[2]) ? 2 : value.startsWith(PREFIXES[1]) ? 1 : null
  let parsed: unknown
  try {
    parsed =
      version === null
        ? null
        : JSON.parse(
            Buffer.from(value.slice(PREFIXES[version].length), 'base64url').toString('utf8')
          )
  } catch {
    throw invalidCursor()
  }
  if (isRecord(parsed) && parsed.v === 1 && version === 1 && parsed.s === 'chat') {
    // A version 1 chat cursor at a row boundary still reads; one inside a row (`w`) counted
    // positions no current reader can map back.
    parsed = parsed.w === undefined ? { ...parsed, v: 2 } : null
  } else if (!isRecord(parsed) || parsed.v !== version) {
    parsed = null
  }
  if (!isReadCursor(parsed)) {
    throw invalidCursor()
  }
  if (parsed.id !== orcaSessionId) {
    throw new AgentConversationRefusal(
      CODES.invalidCursor,
      `That cursor is from another agent's read; read agent ${orcaSessionId} without it first.`
    )
  }
  return parsed
}

function isReadCursor(cursor: unknown): cursor is ReadCursor {
  if (!isRecord(cursor) || typeof cursor.id !== 'string') {
    return false
  }
  if (cursor.v === 2 && cursor.s === 'chat') {
    return (
      typeof cursor.session === 'string' &&
      isRecord(cursor.journal) &&
      typeof cursor.journal.epoch === 'string' &&
      typeof cursor.journal.sequence === 'number' &&
      Number.isSafeInteger(cursor.journal.sequence) &&
      cursor.journal.sequence >= 0 &&
      (cursor.partial === undefined ||
        isAgentReadPartialRow(cursor.partial, cursor.journal.sequence))
    )
  }
  return (
    cursor.v === 1 &&
    cursor.s === 'transcript' &&
    typeof cursor.i === 'string' &&
    typeof cursor.p === 'number' &&
    Number.isSafeInteger(cursor.p) &&
    cursor.p >= 0 &&
    (cursor.c === undefined || typeof cursor.c === 'string')
  )
}

export function invalidCursor(): AgentConversationRefusal {
  return new AgentConversationRefusal(
    CODES.invalidCursor,
    'That read cursor is not valid. Read again without --cursor.'
  )
}
