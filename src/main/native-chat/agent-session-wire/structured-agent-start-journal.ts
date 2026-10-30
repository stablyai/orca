import type { AgentJournalAgentStartItem } from '../../../shared/agent-session-journal-types'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { readJournalSessionEpoch } from '../agent-session-journal/journal-row-table'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'

type AgentStartDestination = { sessionId: string; epoch: string; contextId: string | null }

export function structuredAgentStartJournal(
  deps: () => StructuredAgentSessionHostDeps,
  conversation: (sessionId: string) => Promise<StructuredAgentSessionHostSession>
) {
  /** Record only in this transcript; opening at rest neither follows clears nor starts its agent. */
  const captureAgentStartDestination = (sessionId: string): AgentStartDestination | null => {
    const record = deps().store.getConversation(sessionId)
    const epoch = readJournalSessionEpoch(deps().journalDatabase.db, sessionId)
    return record && epoch
      ? { sessionId, epoch, contextId: record.providerContextBoundary?.operationId ?? null }
      : null
  }

  const appendAgentStart = async (
    destination: AgentStartDestination,
    body: AgentJournalAgentStartItem,
    observedAt: number
  ): Promise<void> => {
    const { sessionId } = destination
    const stillSameContext = () => {
      const current = captureAgentStartDestination(sessionId)
      return current?.epoch === destination.epoch && current?.contextId === destination.contextId
    }
    if (!stillSameContext()) {
      return
    }
    const { journal } = await conversation(sessionId)
    const identity = {
      provider: 'orca' as const,
      clientMessageId: `agent-start:${body.dispatchId}`
    }
    await journal.appendResolvedItem(
      () => {
        if (!stillSameContext() || journal.hasRecordedItem(agentJournalItemKey(identity))) {
          return null
        }
        return { identity, body }
      },
      {
        fence: deps().store.getConversation(sessionId)?.currentFence ?? 0,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE,
        observedAt
      }
    )
  }

  return { captureAgentStartDestination, appendAgentStart }
}
