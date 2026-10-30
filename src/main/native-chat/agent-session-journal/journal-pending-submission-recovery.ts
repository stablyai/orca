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

/** Process exit makes handed-over sends unknown, never safely retryable; leave unhanded queues alone. */
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

/** Failed initialization proves no message ran; delivery loops settle unhanded queued messages separately. */
export async function rejectJournalPendingSubmissions(
  journal: AgentSessionJournal,
  fence: number,
  rejection: AgentJournalDispatchRejection
): Promise<string[]> {
  const unwritten = journalPendingSubmissionResolutions(journal.submissions(), fence, { rejection })
  for (const resolution of unwritten) {
    await journal.resolveDispatch(resolution)
  }
  return unwritten.map((entry) => entry.clientMessageId)
}

export async function rejectJournalQueuedSubmissions(
  journal: AgentSessionJournal,
  fence: number,
  rejection: AgentJournalDispatchRejection,
  which: (submission: AgentJournalSubmission) => boolean = () => true
): Promise<string[]> {
  const queued = journal
    .submissions()
    .filter((entry) => isQueuedAgentJournalSubmission(entry) && which(entry))
  // Issue together so Stop observes every withdrawal once this call returns.
  await Promise.all(
    queued.map((entry) =>
      journal.resolveDispatch({
        clientMessageId: entry.clientMessageId,
        state: 'rejected',
        ...rejection,
        fence,
        recovered: true
      })
    )
  )
  return queued.map((entry) => entry.clientMessageId)
}

/** Resolve queued rejections at write time so they commit atomically with the enclosing append. */
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
