import {
  AGENT_CONVERSATION_REFUSAL_CODES as CODES,
  type AgentConversationKind
} from '../../../shared/agent-conversations/agent-conversation-contracts'
import { AgentConversationRefusal } from './agent-conversation-refusal'
import type {
  JournalAgentReadIssue,
  JournalItemPosition
} from '../../native-chat/agent-session-journal/journal-domain-agent-read'
import type { WorkerTranscriptOlderBoundary } from '../orchestration/workers/transcripts/worker-transcript-local-read'
import {
  decodeVersionedJsonCursor,
  encodeVersionedJsonCursor
} from '../opaque-cursors/versioned-json-cursor'

const AGENT_READ_CURSOR_PREFIX = 'oar1_'
const AGENT_READ_CURSOR_MAX_LENGTH = 2_048
const MAX_FIELD_CHARS = 512

/** Where a terminal agent's next older page ends, in a file of this identity. */
export type TerminalAgentReadPosition = WorkerTranscriptOlderBoundary & {
  sourceFingerprint: string
}

/** Where a chat's next older page starts, in the snapshot of the newer page. */
export type ChatAgentReadPosition = JournalAgentReadIssue & {
  /** The running session behind the Orca session ID. */
  sessionId: string
  /** The public epoch; `/compact` or a non-local rewind changes it. */
  epoch: string
  /** The oldest item the newer page consumed; its ordinal names the item. */
  anchor: JournalItemPosition
}

type CursorOwner = { v: 1; o: string; k: AgentConversationKind }
type ChatCursorPayload = CursorOwner & {
  k: 'chat'
  s: string
  e: string
  h: number
  n: number
  a: [number, number, number]
}
type TerminalCursorPayload = CursorOwner & {
  k: 'terminal'
  p: number
  r?: 1
  f: string
  c: string
}

export function encodeTerminalAgentReadCursor(
  orcaSessionId: string,
  position: TerminalAgentReadPosition
): string {
  const payload: TerminalCursorPayload = {
    v: 1,
    o: orcaSessionId,
    k: 'terminal',
    p: position.offset,
    ...(position.insideRecord ? { r: 1 as const } : {}),
    f: position.sourceFingerprint,
    c: position.boundaryCheckpoint
  }
  return encodeCursor(payload)
}

export function decodeTerminalAgentReadCursor(
  cursor: string,
  orcaSessionId: string
): TerminalAgentReadPosition {
  const payload = decodeOwnedPayload(cursor, orcaSessionId, 'terminal')
  if (
    !isPositiveSafeInteger(payload.p) ||
    (payload.r !== undefined && payload.r !== 1) ||
    !isBoundedString(payload.f) ||
    !isBoundedString(payload.c)
  ) {
    throw invalidAgentReadCursor(orcaSessionId)
  }
  return {
    offset: payload.p,
    ...(payload.r === 1 ? { insideRecord: true } : {}),
    sourceFingerprint: payload.f,
    boundaryCheckpoint: payload.c
  }
}

export function encodeChatAgentReadCursor(
  orcaSessionId: string,
  position: ChatAgentReadPosition
): string {
  const { anchor } = position
  const payload: ChatCursorPayload = {
    v: 1,
    o: orcaSessionId,
    k: 'chat',
    s: position.sessionId,
    e: position.epoch,
    h: position.headSequence,
    n: position.maxOrdinal,
    a: [anchor.sequence, anchor.sequenceIndex, anchor.ordinal]
  }
  return encodeCursor(payload)
}

export function decodeChatAgentReadCursor(
  cursor: string,
  orcaSessionId: string
): ChatAgentReadPosition {
  const payload = decodeOwnedPayload(cursor, orcaSessionId, 'chat')
  const anchor = payload.a
  if (
    !isBoundedString(payload.s) ||
    !isBoundedString(payload.e) ||
    !isCount(payload.h) ||
    !isCount(payload.n) ||
    !Array.isArray(anchor) ||
    anchor.length !== 3 ||
    !anchor.every(isCount)
  ) {
    throw invalidAgentReadCursor(orcaSessionId)
  }
  const [sequence, sequenceIndex, ordinal] = anchor
  return {
    sessionId: payload.s,
    epoch: payload.e,
    headSequence: payload.h,
    maxOrdinal: payload.n,
    anchor: { sequence, sequenceIndex, ordinal }
  }
}

/** A cursor that no longer fits the agent's history; the caller starts over from the newest page. */
export function staleAgentReadCursor(orcaSessionId: string): AgentConversationRefusal {
  return new AgentConversationRefusal(
    CODES.cursorStale,
    `Agent ${orcaSessionId}'s history changed since this cursor was issued, so Orca can't continue from it without skipping entries. Read it again without --cursor.`
  )
}

function invalidAgentReadCursor(orcaSessionId: string): AgentConversationRefusal {
  return new AgentConversationRefusal(
    CODES.cursorInvalid,
    `That --cursor isn't one Orca issued for agent ${orcaSessionId}. Read the agent without --cursor and use the cursor its output prints.`
  )
}

function encodeCursor(payload: CursorOwner): string {
  return encodeVersionedJsonCursor(AGENT_READ_CURSOR_PREFIX, payload)
}

function decodeOwnedPayload(
  cursor: string,
  orcaSessionId: string,
  kind: AgentConversationKind
): Record<string, unknown> {
  const parsed = decodeVersionedJsonCursor(
    cursor,
    AGENT_READ_CURSOR_PREFIX,
    AGENT_READ_CURSOR_MAX_LENGTH
  )
  if (!isRecord(parsed) || parsed.v !== 1 || parsed.o !== orcaSessionId || parsed.k !== kind) {
    throw invalidAgentReadCursor(orcaSessionId)
  }
  return parsed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_FIELD_CHARS
}
