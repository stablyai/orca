// A note Orca writes into a conversation: its clients show it, its agent is never sent it.

import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalPlainStatusItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSessionHost } from './host/structured-agent-session-host'
import { structuredAgentSessionConversationFence } from './host/structured-agent-session-provider-child'

/** Writing the same id again revises the note in place. */
export async function writeStructuredAgentSessionOrcaNote(
  host: Pick<StructuredAgentSessionHost, 'deps' | 'conversation'>,
  sessionId: string,
  clientMessageId: string,
  body: AgentJournalPlainStatusItem
): Promise<void> {
  const { journal } = await host.conversation(sessionId)
  await journal.appendItem({ provider: 'orca', clientMessageId }, body, {
    fence: structuredAgentSessionConversationFence(host.deps.store, sessionId),
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
}
