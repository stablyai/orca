import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from '../../../../shared/agent-session/requests/agent-session-queued-submission'
import type { JournalInputWork } from './journal-input-obligations'

export function journalInputAttemptEndedFromFacts(
  send: AgentJournalSubmission,
  work: JournalInputWork | null,
  facts: { fence: number; ended: boolean }
): boolean {
  if (isQueuedAgentJournalSubmission(send)) {
    return false
  }
  const original = {
    ...send,
    fence: facts.fence
  }
  if (!work?.allowsObservation() || work.owesSend(original)) {
    return false
  }
  if (work.generationEnded(original) || (send.dispatchState === 'unknown' && send.recovered)) {
    return true
  }
  return facts.ended
}
