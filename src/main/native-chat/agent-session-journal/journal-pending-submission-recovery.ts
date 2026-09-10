import { DISPATCH_DOUBT_HOST_RESTARTED } from './journal-dispatch-doubt-reasons'
import type { AgentSessionJournal } from './journal-store'

/** Settles every submission a process fact left unanswerable. `reason` says
 *  which fact, and is what a later Retry reads to know the message never
 *  reached a provider. */
export async function markJournalPendingSubmissionsUnknown(
  journal: AgentSessionJournal,
  fence: number,
  reason: string = DISPATCH_DOUBT_HOST_RESTARTED
): Promise<string[]> {
  const pending = journal.pendingSubmissions().map((entry) => entry.clientMessageId)
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
