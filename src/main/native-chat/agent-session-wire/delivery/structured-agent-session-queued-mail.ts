import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { orchestrationMailNotice } from '../../../../shared/agent-session/agent-session-message-source'
import type { QueuedMessageOwed } from '../../agent-session-journal/queued-messages/queued-message-consume-error'
import type { QueuedMessageRow } from '../../agent-session-journal/queued-messages/queued-message-table'
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

/** Mail the queue cannot decide on now: kept in place, and passed over for the person's cards behind it.
 *  A read only, so choosing the next card never settles anything. */
export function queuedMailUnavailable(
  deps: OwedDeps,
  sessionId: string
): (card: QueuedMessageRow) => boolean {
  return ({ body: { from } }) =>
    Boolean(from && orchestrationMailNotice(from)) &&
    deps.queuedAgentMessageOwed?.(sessionId, from!, true) === 'unavailable'
}
