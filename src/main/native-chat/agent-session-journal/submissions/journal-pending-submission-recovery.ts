import type { AgentJournalDispatchRejection } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from '../../../../shared/agent-session/requests/agent-session-queued-submission'
import type { ResolveDispatchInput } from '../journal-store-contracts'

export type JournalPendingSubmission = Pick<
  AgentJournalSubmission,
  'clientMessageId' | 'dispatchState' | 'handoverRecorded' | 'handedOverAt' | 'recovered'
> & { reason?: string | null }

export function journalPendingSubmissionResolutions(
  submissions: readonly JournalPendingSubmission[],
  fence: number,
  verdict: { reason: string } | { rejection: AgentJournalDispatchRejection }
): ResolveDispatchInput[] {
  return submissions
    .filter(
      (entry) =>
        !isQueuedAgentJournalSubmission(entry) &&
        (entry.dispatchState === 'pending' ||
          (entry.dispatchState === 'unknown' && entry.recovered !== true))
    )
    .map((entry) =>
      'rejection' in verdict
        ? {
            clientMessageId: entry.clientMessageId,
            state: 'rejected',
            ...verdict.rejection,
            fence,
            recovered: true
          }
        : {
            clientMessageId: entry.clientMessageId,
            state: 'unknown',
            reason:
              entry.dispatchState === 'unknown' && entry.reason != null
                ? entry.reason
                : verdict.reason,
            fence,
            recovered: true
          }
    )
}
