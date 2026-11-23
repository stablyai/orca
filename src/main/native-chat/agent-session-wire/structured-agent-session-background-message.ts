import { isUnsettledQueuedMessage } from '../agent-session-journal/queued-messages/queued-message-table'
import type { StructuredAgentSessionHost } from './host/structured-agent-session-host'

export async function canAdmitBackgroundMessage(
  host: Pick<StructuredAgentSessionHost, 'hasSession' | 'conversation' | 'currentWork'>,
  sessionId: string,
  ownMessageId?: string
): Promise<boolean> {
  // Checked before the call, so only an already open conversation is read and none is opened.
  const session = host.hasSession(sessionId) ? await host.conversation(sessionId) : undefined
  const work = await host.currentWork(sessionId)
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
