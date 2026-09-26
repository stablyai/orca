import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { DISPATCH_DOUBT_HOST_RESTARTED } from './journal-dispatch-doubt-reasons'
import type { AgentSessionJournal } from './journal-store'

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

/** Settles every submission a child that never proved its start left unanswered as `rejected`:
 *  such a child accepted nothing, so each is provably unwritten and safe to send again. A queued
 *  submission was never handed to that child; the delivery loop settles it. */
export async function rejectJournalPendingSubmissions(
  journal: AgentSessionJournal,
  fence: number,
  reason: string
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
      reason,
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
  reason: string,
  which: (submission: AgentJournalSubmission) => boolean = () => true
): Promise<string[]> {
  const queued = journal
    .submissions()
    .filter((entry) => isQueuedAgentJournalSubmission(entry) && which(entry))
  for (const entry of queued) {
    await journal.resolveDispatch({
      clientMessageId: entry.clientMessageId,
      state: 'rejected',
      reason,
      fence,
      recovered: true
    })
  }
  return queued.map((entry) => entry.clientMessageId)
}
