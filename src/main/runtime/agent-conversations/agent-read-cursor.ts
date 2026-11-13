import { AGENT_CONVERSATION_REFUSAL_CODES as CODES } from '../../../shared/agent-conversations/agent-conversation-contracts'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { AgentConversationRefusal } from './agent-conversation-refusal'
import { isRecord } from '../../../shared/agent-status/child-work/agent-status-child-work-value-guards'

const CURSOR_PREFIX = 'oar1_'

/** Where the next `orca agent read` continues, pinned to one agent and one source. */
export type ReadCursor =
  | { v: 1; id: string; s: 'chat'; session: string; journal: AgentJournalCursor }
  | { v: 1; id: string; s: 'transcript'; i: string; p: number; c?: string }

export function encodeReadCursor(cursor: ReadCursor): string {
  return `${CURSOR_PREFIX}${Buffer.from(JSON.stringify(cursor)).toString('base64url')}`
}

export function decodeReadCursor(value: string, orcaSessionId: string): ReadCursor {
  let parsed: unknown
  try {
    parsed = value.startsWith(CURSOR_PREFIX)
      ? JSON.parse(Buffer.from(value.slice(CURSOR_PREFIX.length), 'base64url').toString('utf8'))
      : null
  } catch {
    throw invalidCursor()
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
  if (!isRecord(cursor) || cursor.v !== 1 || typeof cursor.id !== 'string') {
    return false
  }
  if (cursor.s === 'chat') {
    return (
      typeof cursor.session === 'string' &&
      isRecord(cursor.journal) &&
      typeof cursor.journal.epoch === 'string' &&
      Number.isSafeInteger(cursor.journal.sequence)
    )
  }
  return (
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
