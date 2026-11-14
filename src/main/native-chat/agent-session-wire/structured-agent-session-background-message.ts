import { isUnsettledQueuedMessage } from '../agent-session-journal/queued-messages/queued-message-table'
import type { StructuredAgentSessionHostSession } from './host/structured-agent-session-host-types'
import type { StructuredAgentSessionClientDelivery } from './publication/subscribers/structured-agent-session-client-delivery'

export function backgroundAdmission(
  readSessions: () => ReadonlyMap<string, StructuredAgentSessionHostSession>,
  currentWork: StructuredAgentSessionClientDelivery['readCurrentWork']
) {
  return async (sessionId: string, ownMessageId?: string): Promise<boolean> => {
    const session = readSessions().get(sessionId)
    const work = await currentWork(sessionId)
    if (!session || !work || work.hasActionablePrompt() || work.activeTurnId() !== null) {
      return false
    }
    const state = work.queueState()
    const owed = [...state.owedEnteredSubmissions, ...state.owedSendingSubmissions]
    return (
      !(await session.journal.queuedMessages.list()).some(isUnsettledQueuedMessage) &&
      !owed.some((submission) => submission.clientMessageId !== ownMessageId)
    )
  }
}
