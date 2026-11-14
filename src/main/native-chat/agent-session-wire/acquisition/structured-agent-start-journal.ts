import type {
  AgentJournalAgentHandoffItem,
  AgentJournalAgentStartItem
} from '../../../../shared/agent-session/journal/agent-journal-creation-facts'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { restoreJournalSqlFailure } from '../../agent-session-journal/journal-sql-failure'
import { estimateStructuredAgentSessionItemBytes } from '../journal-ingress/structured-agent-session-event-sink-estimate'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from '../host/structured-agent-session-host-types'

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
  ): Promise<AgentStartDestination | null> | null => {
    const record = deps().store.getConversation(sessionId)
    if (!record) {
      return null
    }
    const contextId = record.providerContextBoundary?.operationId ?? null
    return deps()
      .journalDatabase.sessionEpoch(sessionId)
      .then((epoch) => {
        const current = deps().store.getConversation(sessionId)
        return epoch &&
          current &&
          (current.providerContextBoundary?.operationId ?? null) === contextId
          ? { sessionId, epoch, contextId }
          : null
      })
  }

  const appendAgentStart = async (
    destination: AgentStartDestination,
    body: AgentJournalAgentStartItem | AgentJournalAgentHandoffItem,
    observedAt: number
  ): Promise<void> => {
    const { sessionId } = destination
    const stillSameContext = () => {
      const current = deps().store.getConversation(sessionId)
      return (
        current !== null &&
        (current.providerContextBoundary?.operationId ?? null) === destination.contextId
      )
    }
    if (!stillSameContext()) {
      return
    }
    const { journal } = await conversation(sessionId)
    const identity = {
      provider: 'orca' as const,
      clientMessageId: agentStartClientMessageId(body)
    }
    const result = await journal.appendSteps(
      [
        {
          kind: 'creation-fact',
          epoch: destination.epoch,
          identity,
          body,
          reservedBytes: estimateStructuredAgentSessionItemBytes(identity, body),
          options: {
            fence: deps().store.getConversation(sessionId)?.currentFence ?? 0,
            turnScope: AGENT_JOURNAL_THREAD_SCOPE,
            observedAt
          }
        }
      ],
      stillSameContext
    )
    if (result.failure) {
      throw restoreJournalSqlFailure(result.failure)
    }
  }

  return { captureAgentStartDestination, appendAgentStart }
}
