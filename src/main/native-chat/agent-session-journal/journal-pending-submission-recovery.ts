import type { AgentSessionJournal } from './journal-store'

export async function markJournalPendingSubmissionsUnknown(
  journal: AgentSessionJournal,
  fence: number,
  reason = 'host_restarted_before_acknowledgement'
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
