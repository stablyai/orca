import type { AgentSessionJournal } from './journal-store'

export async function markJournalPendingSubmissionsUnknown(
  journal: AgentSessionJournal,
  fence: number
): Promise<string[]> {
  const pending = journal.pendingSubmissions().map((entry) => entry.clientMessageId)
  for (const clientMessageId of pending) {
    await journal.resolveDispatch({
      clientMessageId,
      state: 'unknown',
      reason: 'host_restarted_before_acknowledgement',
      fence,
      recovered: true
    })
  }
  return pending
}
