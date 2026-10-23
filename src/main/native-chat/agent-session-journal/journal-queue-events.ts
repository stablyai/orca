// The queue's journal rows. Every fact about a queued message is one of these, in the chat's own
// history beside the submission that hands it off and the dispatch row that answers it, so the
// card is folded by THE reducer (`journal-queue-fold.ts`) and nothing stores it a second time.

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
      /** Queue order: the queue sends the lowest first. */
      position: number
      /** Where the journal stood when it was queued; null on a card from before it was recorded. */
      queuedAt: AgentJournalCursor | null
      /** Holds this one card from sending by itself (`QueuedMessageHoldReason`). */
      holdReason?: string
      /** The model and effort its send carried. */
      options?: AgentSessionExecutionOptions
      /** A restated or imported card's hand-off: the submission it went out as. */
      attempt?: string
      /** Only where the refusal's own rows are gone (a replaced epoch, an imported card whose hand-off
       *  is not in this one), so exactly one copy of a refusal exists at any time. */
      returned?: { reason: string | null; rejection?: UnreadAgentSessionFailureFact }
    }
  | { op: 'edited'; body: AgentJournalMessageItem }
  | { op: 'moved'; position: number }
  | { op: 'held'; holdReason: string }
  | { op: 'withdrawn' }

export type JournalQueuedChange = Extract<JournalQueueChange, { op: 'queued' }>

export type JournalQueueRow = JournalRowBase & {
  kind: 'queue'
  /** The card's stable id: the send it was queued as. */
  messageId: string
  change: JournalQueueChange
}

/** One card's change; absent: only adopt the card into the journal (`journal-queue-import.ts`). */
export type JournalQueueCardChange = { messageId: string; change?: JournalQueueChange }

/** A queue row in the live epoch. Its fence is the journal's own: a card is no generation's work,
 *  so it never goes stale behind a newer owner. */
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

/** The row's own fields. Optional fields are read defensively by the fold, so only what a card
 *  cannot exist without fails the row; an op this build does not know is a newer build's. */
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
