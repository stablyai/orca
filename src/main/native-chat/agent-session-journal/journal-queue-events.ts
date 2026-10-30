// Queue facts share the chat journal/reducer; no second stored copy may drift behind dispatch state.

import type { UnreadAgentSessionFailureFact } from '../../../shared/agent-session-failure'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session-execution-options'
import {
  AGENT_SESSION_JOURNAL_QUEUE_SCHEMA_VERSION,
  type AgentJournalCursor,
  type AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'
import {
  readAgentJournalMessageBody,
  type AgentJournalContentVerdict
} from '../../../shared/agent-session-journal-body-admission'
import { isJournalTag } from '../../../shared/agent-session-journal-open-union'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRowBase } from './journal-row-schema'

export type JournalQueueChange =
  | {
      op: 'queued'
      body: AgentJournalMessageItem
      position: number
      /** null means a legacy card did not record its enqueue cursor. */
      queuedAt: AgentJournalCursor | null
      holdReason?: string
      options?: AgentSessionExecutionOptions
      attempt?: string
      /** Retain refusal facts only when their original handoff rows are gone. */
      returned?: { reason: string | null; rejection?: UnreadAgentSessionFailureFact }
    }
  | { op: 'edited'; body: AgentJournalMessageItem }
  | { op: 'moved'; position: number }
  | { op: 'held'; holdReason: string }
  | { op: 'withdrawn' }

export type JournalQueuedChange = Extract<JournalQueueChange, { op: 'queued' }>

export type JournalQueueRow = JournalRowBase & {
  kind: 'queue'
  messageId: string
  change: JournalQueueChange
}

/** Absent change adopts the legacy card without altering it. */
export type JournalQueueCardChange = { messageId: string; change?: JournalQueueChange }

/** Cards belong to the journal, not an execution generation, and must not expire with writer fences. */
export function journalQueueRowBuilder(
  state: () => JournalReducerState,
  messageId: string,
  change: JournalQueueChange
): (seq: number, ts: number) => JournalQueueRow {
  return (seq, ts) => buildJournalQueueRow(state(), messageId, change, seq, ts)
}

export function buildJournalQueueRow(
  state: JournalReducerState,
  messageId: string,
  change: JournalQueueChange,
  seq: number,
  ts: number
): JournalQueueRow {
  return {
    kind: 'queue',
    messageId,
    change,
    v: AGENT_SESSION_JOURNAL_QUEUE_SCHEMA_VERSION,
    epoch: state.epoch,
    seq,
    fence: state.highestFence,
    ts
  }
}

/** Invalid annotations are dropped; missing essential fields are malformed, unknown ops unreadable. */
export function journalQueueRowContent(
  record: Record<string, unknown>
): AgentJournalContentVerdict {
  const { change } = record
  if (
    typeof record.messageId !== 'string' ||
    record.messageId.length === 0 ||
    typeof change !== 'object' ||
    change === null ||
    !('op' in change)
  ) {
    return 'malformed'
  }
  const position = 'position' in change && Number.isFinite(change.position)
  const body = 'body' in change ? readAgentJournalMessageBody(change.body) : 'malformed'
  switch (change.op) {
    case 'queued':
      return position ? body : 'malformed'
    case 'edited':
      return body
    case 'moved':
      return position ? 'readable' : 'malformed'
    case 'held':
      return 'holdReason' in change && typeof change.holdReason === 'string'
        ? 'readable'
        : 'malformed'
    case 'withdrawn':
      return 'readable'
    default:
      return isJournalTag(change.op) ? 'unreadable' : 'malformed'
  }
}
