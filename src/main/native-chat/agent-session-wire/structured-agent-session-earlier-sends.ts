import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { journalPendingSubmissionResolutions } from '../agent-session-journal/journal-pending-submission-recovery'
import { DISPATCH_DOUBT_HOST_RESTARTED } from '../agent-session-journal/journal-dispatch-doubt-reasons'

/** A handle reopened after eviction must not recover sends accepted by this process. */
export function earlierStructuredAgentSessionSequence(
  journal: AgentSessionJournal,
  opened: AgentJournalCursor,
  sequence: number | undefined
): boolean {
  return (
    journal.cursor().epoch === opened.epoch && sequence !== undefined && sequence <= opened.sequence
  )
}

export async function markEarlierStructuredAgentSessionPending(
  journal: AgentSessionJournal,
  fence: number,
  opened: AgentJournalCursor,
  writes: Pick<AgentSessionJournal, 'resolveDispatch'> = journal
): Promise<void> {
  const earlier = journal
    .submissions()
    .filter((entry) =>
      earlierStructuredAgentSessionSequence(
        journal,
        opened,
        entry.acceptedSequence ?? entry.submittedSequence
      )
    )
  for (const resolution of journalPendingSubmissionResolutions(earlier, fence, {
    reason: DISPATCH_DOUBT_HOST_RESTARTED
  })) {
    await writes.resolveDispatch(resolution)
  }
}
