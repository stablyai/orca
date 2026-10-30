import type { JournalMailSource } from '../agent-session-journal/journal-mail-boundary'
import type { AgentSessionSendResult } from '../../../shared/agent-session-wire'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import { maybeQueueStructuredAgentSessionSend } from './structured-agent-session-queued-messages'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'

export async function runQueueableStructuredAgentSessionSend(
  context: StructuredAgentSessionMutationContext,
  ctx: AgentSessionTurnContext,
  params: {
    envelope: { clientOperationId: string }
    body: AgentJournalMessageItem
    delivery?: 'queue-if-active'
    queuedImageCards?: boolean
    options?: Readonly<Record<string, string>>
    userSend?: true
    beforeRun?: () => void
    queueAlways?: true
    mailSource?: JournalMailSource
    personsMessage?: true
  },
  immediate: () => Promise<TurnOutcome<AgentSessionSendResult>>
): Promise<TurnOutcome<AgentSessionSendResult>> {
  // Decide queueing first; blocked sends fall through to immediate refusal.
  const queued = await maybeQueueStructuredAgentSessionSend(context, ctx, params)
  if (queued) {
    return queued
  }
  return immediate()
}
