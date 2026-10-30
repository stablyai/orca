// Open a chat on demand without starting a child; failed journal opens retain a Retry tab.

import { agentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import { journalOpenRefusal } from '../agent-session-journal/journal-open-failure'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionReveal
} from './structured-agent-session-host-types'

export async function revealStructuredAgentSession(
  deps: { store: Pick<StructuredAgentSessionHostDeps['store'], 'getConversation'> },
  sessionId: string,
  openConversation: (sessionId: string) => Promise<unknown>
): Promise<StructuredAgentSessionReveal> {
  const record = deps.store.getConversation(sessionId)
  if (!record) {
    throw agentSessionRefusalError('agent_session_identity_required', { reason: 'recordMissing' })
  }
  // Reveal grants no ownership, so contested/reconciling leases must remain inspectable.
  const openRefusal = await openConversation(sessionId).then(
    () => null,
    (error: unknown) => journalOpenRefusal(error)
  )
  return {
    sessionId,
    // Record-authoritative workspace prevents caller-directed tab publication.
    workspaceId: record.location.workspaceId,
    agent: record.provider,
    readable: openRefusal === null,
    ...(openRefusal ? { openRefusal } : {})
  }
}
