import type { AgentJournalDispatchRejection } from '../../../shared/agent-session-failure-words'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { DISPATCH_DOUBT_HOST_RESTARTED } from './journal-dispatch-doubt-reasons'
import type { JournalReducerState } from './journal-reducer'
import { journalDispatchRowBuilder } from './journal-row-builders'
import type { JournalRow } from './journal-row-schema'
import type { AgentSessionJournal } from './journal-store'
import type { JournalBatchRejection } from './journal-store-contracts'

/** Settles every submission a process fact left unanswerable. Doubt is never
 *  proof of non-delivery, so nothing here ever becomes re-deliverable. A queued
 *  submission was never handed over, so it is not in doubt and is left alone. */
export async function markJournalPendingSubmissionsUnknown(
  journal: AgentSessionJournal,
  fence: number,
  reason: string = DISPATCH_DOUBT_HOST_RESTARTED
): Promise<string[]> {
  const unresolved = journal
    .submissions()
    .filter(
      (entry) =>
        !isQueuedAgentJournalSubmission(entry) &&
        (entry.dispatchState === 'pending' ||
          (entry.dispatchState === 'unknown' && entry.recovered !== true))
    )
  for (const entry of unresolved) {
    // An earlier reason already names a sharper fact than "the host restarted".
    const resolvedReason =
      entry.dispatchState === 'unknown' && entry.reason !== null ? entry.reason : reason
    await journal.resolveDispatch({
      clientMessageId: entry.clientMessageId,
      state: 'unknown',
      reason: resolvedReason,
      fence,
      recovered: true
    })
  }
  return unresolved.map((entry) => entry.clientMessageId)
}

/** Settles as `rejected` every submission a child handed over and never echoed, when that child
 *  ended in its start: one that never answered initialize ran nothing, so each is safe to send
 *  again. A queued submission was never handed to that child; the delivery loop settles it. */
export async function rejectJournalPendingSubmissions(
  journal: AgentSessionJournal,
  fence: number,
  rejection: AgentJournalDispatchRejection
): Promise<string[]> {
  const unwritten = journal
    .submissions()
    .filter(
      (entry) =>
        !isQueuedAgentJournalSubmission(entry) &&
        (entry.dispatchState === 'pending' ||
          (entry.dispatchState === 'unknown' && entry.recovered !== true))
    )
  for (const entry of unwritten) {
    await journal.resolveDispatch({
      clientMessageId: entry.clientMessageId,
      state: 'rejected',
      ...rejection,
      fence,
      recovered: true
    })
  }
  return unwritten.map((entry) => entry.clientMessageId)
}

/** Rejects queued submissions — accepted, never handed over, so provably unwritten. */
export async function rejectJournalQueuedSubmissions(
  journal: AgentSessionJournal,
  fence: number,
  rejection: AgentJournalDispatchRejection,
  which: (submission: AgentJournalSubmission) => boolean = () => true
): Promise<string[]> {
  const queued = journal
    .submissions()
    .filter((entry) => isQueuedAgentJournalSubmission(entry) && which(entry))
  // Issued together, so the fold shows none of them queued once this call returns: a Stop decides
  // whether anything is working from it without awaiting the withdrawal.
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

/** The row rejecting that one submission, read from `state` when called, or none when `which` no
 *  longer holds for it: for an append that must carry it with what follows, in one transaction. */
export function journalBatchRejectionRowBuilders(
  state: () => JournalReducerState,
  fence: number,
  { clientMessageId, which, ...rejection }: JournalBatchRejection
): ((seq: number, ts: number) => JournalRow)[] {
  const submission = state().submissions.get(clientMessageId)
  return submission && which(submission)
    ? [
        journalDispatchRowBuilder(state, {
          clientMessageId,
          state: 'rejected',
          ...rejection,
          fence
        })
      ]
    : []
}
