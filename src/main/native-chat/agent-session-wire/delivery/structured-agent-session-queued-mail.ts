import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { orchestrationMailNotice } from '../../../../shared/agent-session/journal/agent-session-message-source'
import type { QueuedMessageOwed } from '../../agent-session-journal/queued-messages/queued-message-consume-error'
import type { StructuredAgentSessionHostDeps } from '../host/structured-agent-session-host-types'

type OwedDeps = Pick<StructuredAgentSessionHostDeps, 'queuedAgentMessageOwed'>

/** A mail card asks whether it is still owed when it is handed over; anything else always is, and
 *  never waits on the mail's records to be read. */
export function queuedMessageOwed(
  deps: OwedDeps,
  sessionId: string,
  body: AgentJournalMessageItem
): (() => QueuedMessageOwed) | undefined {
  const { from } = body
  const decide = deps.queuedAgentMessageOwed
  return from && orchestrationMailNotice(from) && decide ? () => decide(sessionId, from) : undefined
}

/** Admits a card for handover and returns its owed check. Stale mail skips the admission guard, so
 *  the handoff withdraws it instead of the guard holding it as a failed send. */
export function admitQueuedMessage(
  deps: Pick<
    StructuredAgentSessionHostDeps,
    'queuedAgentMessageOwed' | 'assertQueuedMessageAllowed'
  >,
  sessionId: string,
  messageId: string,
  body: AgentJournalMessageItem
): (() => QueuedMessageOwed) | undefined {
  const owed = queuedMessageOwed(deps, sessionId, body)
  if (!owed || owed() !== 'stale') {
    deps.assertQueuedMessageAllowed?.(sessionId, messageId)
  }
  return owed
}
