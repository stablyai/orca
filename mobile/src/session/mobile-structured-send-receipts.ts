import type { AgentJournalSubmission } from '../../../src/shared/agent-session-journal-types'
import { handedOffQueuedMessageIds } from '../../../src/shared/structured-agent-session-draft-hand-off'

/** The host holds every published submission and draft hand-off, whatever its dispatch state. */
export function mobileStructuredSendReceipts(
  submissions: readonly AgentJournalSubmission[]
): ReadonlySet<string> {
  const ids = handedOffQueuedMessageIds(submissions)
  for (const submission of submissions) {
    ids.add(submission.clientMessageId)
  }
  return ids
}
