import type { AgentJournalDispatchRejection } from '../../../shared/agent-session-failure-words'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { DISPATCH_DOUBT_HOST_RESTARTED } from './journal-dispatch-doubt-reasons'
import type { JournalReducerState } from './journal-reducer'
import { journalDispatchRowBuilder } from './journal-row-builders'
import type { JournalRow } from './journal-row-schema'
import type { AgentSessionJournal } from './journal-store'
import type { ResolveDispatchInput } from './journal-store-contracts'

export type JournalPendingSubmission = Pick<
  AgentJournalSubmission,
  'clientMessageId' | 'dispatchState' | 'handoverRecorded' | 'handedOverAt' | 'recovered'
> & { reason?: string | null }

/** The same pending-send verdicts for standalone recovery and an atomic terminal settlement. */
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

/** Settles every submission a process fact left unanswerable. Doubt is never
 *  proof of non-delivery, so nothing here ever becomes re-deliverable. A queued
 *  submission was never handed over, so it is not in doubt and is left alone. */
export async function markJournalPendingSubmissionsUnknown(
  journal: AgentSessionJournal,
  fence: number,
  reason: string = DISPATCH_DOUBT_HOST_RESTARTED
): Promise<string[]> {
  const unresolved = journalPendingSubmissionResolutions(journal.submissions(), fence, { reason })
  for (const resolution of unresolved) {
    await journal.resolveDispatch(resolution)
  }
  return unresolved.map((entry) => entry.clientMessageId)
}

/** Rows rejecting every submission still queued, read from `state` when called: for an append
 *  that must carry them with what follows, in one transaction. */
export function journalQueuedRejectionRowBuilders(
  state: () => JournalReducerState,
  fence: number,
  rejection: AgentJournalDispatchRejection
): ((seq: number, ts: number) => JournalRow)[] {
  return [...state().submissions.values()].filter(isQueuedAgentJournalSubmission).map((entry) =>
    journalDispatchRowBuilder(state, {
      clientMessageId: entry.clientMessageId,
      state: 'rejected',
      ...rejection,
      fence,
      recovered: true
    })
  )
}
