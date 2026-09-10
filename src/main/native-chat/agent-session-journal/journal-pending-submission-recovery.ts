import { DISPATCH_DOUBT_HOST_RESTARTED } from './journal-dispatch-doubt-reasons'
import type { AgentSessionJournal } from './journal-store'

/** Settles every submission a process fact left unanswerable. The retry policy
 *  separately decides whether that fact proves the provider never received it. */
export async function markJournalPendingSubmissionsUnknown(
  journal: AgentSessionJournal,
  fence: number,
  reason: string = DISPATCH_DOUBT_HOST_RESTARTED
): Promise<string[]> {
  const pending = journal
    .submissions()
    .filter(
      (entry) =>
        entry.dispatchState === 'pending' ||
        (entry.dispatchState === 'unknown' && entry.recovered !== true)
    )
    .map((entry) => entry.clientMessageId)
  for (const clientMessageId of pending) {
    await journal.resolveDispatch({
      clientMessageId,
      state: 'unknown',
      reason,
      fence,
      recovered: true
    })
  }
  return pending
}
