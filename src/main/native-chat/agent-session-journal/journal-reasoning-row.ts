import type {
  AgentJournalItemBody,
  AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'
import { boundInlineText, DEFAULT_JOURNAL_PAYLOAD_LIMITS } from './journal-payload-bounds'

export type JournalReasoningLifecycle = Pick<AgentJournalMessageItem, 'state' | 'completedAt'>

/** Null for blank reasoning: a block or item with no readable text journals no row. */
export function journalReasoningBody(
  text: string | null,
  lifecycle: JournalReasoningLifecycle = {}
): AgentJournalMessageItem | null {
  return text?.trim()
    ? {
        kind: 'message',
        role: 'reasoning',
        blocks: [
          { type: 'text', text: boundInlineText(text, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text }
        ],
        ...lifecycle
      }
    : null
}

/** Stamps a reasoning row with whether its block or item is still open, as the caller knows it;
 *  every other body passes through untouched. */
export function withJournalReasoningLifecycle(
  body: AgentJournalItemBody,
  lifecycle: JournalReasoningLifecycle
): AgentJournalItemBody {
  return body.kind === 'message' && body.role === 'reasoning' ? { ...body, ...lifecycle } : body
}

/** A reasoning row's end: `completedAt` is when the host saw it end, or the turn or exit that cut
 *  it off; absent when no end was seen live. */
export function endedJournalReasoning(completedAt?: number): JournalReasoningLifecycle {
  return { state: 'completed', ...(completedAt === undefined ? {} : { completedAt }) }
}
