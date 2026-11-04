import type {
  AgentJournalAgentHandoffItem,
  AgentJournalAgentStartItem
} from '../../../shared/agent-session/journal/agent-journal-creation-facts'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'

export type AgentStartDestination = {
  sessionId: string
  epoch: string
  contextId: string | null
}

/** One creation fact per worker Dispatch or agent launch, so a retry or replay never draws it twice. */
function agentStartClientMessageId(
  body: AgentJournalAgentStartItem | AgentJournalAgentHandoffItem
): string {
  return body.kind === 'agent-start'
    ? `agent-start:${body.dispatchId}`
    : `agent-handoff:${body.launchId}`
}

export function structuredAgentStartJournal(
  deps: () => StructuredAgentSessionHostDeps,
  conversation: (sessionId: string) => Promise<StructuredAgentSessionHostSession>
) {
  /** Record only in this transcript; opening at rest neither follows clears nor starts its agent. */
  const captureAgentStartDestination = (
    sessionId: string
  ): Promise<AgentStartDestination | null> => {
    const host = deps()
    return host.journalDatabase.transaction(async (plan) => {
      const record = host.store.getConversation(sessionId)
      const epoch = (
        await plan.read
          .prepare('SELECT epoch FROM journal_sessions WHERE session_id = ?')
          .get(sessionId)
      )?.epoch
      return record && typeof epoch === 'string'
        ? { sessionId, epoch, contextId: record.providerContextBoundary?.operationId ?? null }
        : null
    })
  }

  const appendAgentStart = async (
    destination: AgentStartDestination,
    body: AgentJournalAgentStartItem | AgentJournalAgentHandoffItem,
    observedAt: number
  ): Promise<void> => {
    const { sessionId } = destination
    const currentRecord = () => deps().store.getConversation(sessionId)
    if ((currentRecord()?.providerContextBoundary?.operationId ?? null) !== destination.contextId) {
      return
    }
    const { journal } = await conversation(sessionId)
    const stillSameContext = () =>
      journal.epoch === destination.epoch &&
      (currentRecord()?.providerContextBoundary?.operationId ?? null) === destination.contextId
    const identity = {
      provider: 'orca' as const,
      clientMessageId: agentStartClientMessageId(body)
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
