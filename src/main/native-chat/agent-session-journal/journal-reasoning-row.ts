import type {
  AgentJournalItemBody,
  AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'

export type JournalReasoningLifecycle = Pick<AgentJournalMessageItem, 'state' | 'completedAt'>

export function journalReasoningBody(
  text: string | null,
  lifecycle: JournalReasoningLifecycle = {}
): AgentJournalMessageItem | null {
  return text?.trim()
    ? {
        kind: 'message',
        role: 'reasoning',
        blocks: [{ type: 'text', text }],
        ...lifecycle
      }
    : null
}

export function withJournalReasoningLifecycle(
  body: AgentJournalItemBody,
  lifecycle: JournalReasoningLifecycle
): AgentJournalItemBody {
  return body.kind === 'message' && body.role === 'reasoning' ? { ...body, ...lifecycle } : body
}

/** completedAt records observed completion/interruption; absence means no live end was seen. */
export function endedJournalReasoning(completedAt?: number): JournalReasoningLifecycle {
  return { state: 'completed', ...(completedAt === undefined ? {} : { completedAt }) }
}
