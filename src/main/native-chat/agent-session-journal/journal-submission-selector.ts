import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'

/** A host's choice of sends, as data: every recovery predicate a caller passes today is one of these. */
export type JournalSubmissionSelector = {
  /** Accepted at or before this public cursor, in the same context. */
  acceptedThrough?: AgentJournalCursor
  only?: { clientMessageId: string; fence: number }
  /** Sends the host is still finalizing. */
  except?: readonly string[]
}

export function journalSubmissionSelected(
  selector: JournalSubmissionSelector,
  cursor: () => AgentJournalCursor
): (submission: AgentJournalSubmission) => boolean {
  const { acceptedThrough: through, only, except } = selector
  return (submission) =>
    (!through ||
      (cursor().epoch === through.epoch &&
        submission.acceptedSequence !== undefined &&
        submission.acceptedSequence <= through.sequence)) &&
    (!only ||
      (submission.clientMessageId === only.clientMessageId && submission.fence === only.fence)) &&
    !except?.includes(submission.clientMessageId)
}
