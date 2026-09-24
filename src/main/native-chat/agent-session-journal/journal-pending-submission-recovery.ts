import { DISPATCH_DOUBT_HOST_RESTARTED } from './journal-dispatch-doubt-reasons'
import type { AgentSessionJournal } from './journal-store'

/** Settles every submission a process fact left unanswerable. Doubt is never
 *  proof of non-delivery, so nothing here ever becomes re-deliverable. */
export async function markJournalPendingSubmissionsUnknown(
  journal: AgentSessionJournal,
  fence: number,
  reason: string = DISPATCH_DOUBT_HOST_RESTARTED
): Promise<string[]> {
  const unresolved = journal
    .submissions()
    .filter(
      (entry) =>
        entry.dispatchState === 'pending' ||
        (entry.dispatchState === 'unknown' && entry.recovered !== true)
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
