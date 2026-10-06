import type { AgentJournalDispatchRejection } from '../../../shared/agent-session-failure-words'
import type {
  AgentJournalRejectionCause,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
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

/** A rejection for every queued message alike, or one worded per message. */
type JournalQueuedRejectionWords = AgentJournalDispatchRejection & {
  rejectionCause?: AgentJournalRejectionCause
}

export type JournalQueuedRejection =
  | JournalQueuedRejectionWords
  | ((submission: AgentJournalSubmission) => JournalQueuedRejectionWords)

/** Rejects queued submissions — accepted, never handed over, so provably unwritten. */
export async function rejectJournalQueuedSubmissions(
  journal: AgentSessionJournal,
  fence: number,
  rejection: JournalQueuedRejection,
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
        ...(typeof rejection === 'function' ? rejection(entry) : rejection),
        fence,
        recovered: true
      })
    )
  )
  return queued.map((entry) => entry.clientMessageId)
}
