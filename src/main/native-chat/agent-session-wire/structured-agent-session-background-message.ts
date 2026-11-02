import { isUnsettledQueuedMessage } from '../agent-session-journal/queued-message-table'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import type { StructuredAgentSessionClientDelivery } from './structured-agent-session-client-delivery'

export function backgroundAdmission(
  readSessions: () => ReadonlyMap<string, StructuredAgentSessionHostSession>,
  currentWork: StructuredAgentSessionClientDelivery['readCurrentWork']
) {
  return (sessionId: string, ownMessageId?: string): boolean => {
    const session = readSessions().get(sessionId)
    const work = currentWork(sessionId)
    if (!session || !work || work.hasActionablePrompt() || work.activeTurnId() !== null) {
      return false
    }
    return (
      !session.journal.queuedMessages.list().some(isUnsettledQueuedMessage) &&
      !session.journal
        .submissions()
        .some(
          (submission) =>
            submission.clientMessageId !== ownMessageId && work.scope.owesSend(submission)
        )
    )
  }
}
