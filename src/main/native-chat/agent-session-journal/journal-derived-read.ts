import type { AgentSessionJournal } from './journal-store'
import { finishJournalSteps, finishJournalStepsAsync } from './journal-reconstruction-steps'

const refreshing = new WeakSet<AgentSessionJournal>()

export const journalDerivedRefreshPending = (journal: AgentSessionJournal): boolean =>
  refreshing.has(journal)

/** Every current derived reader shares the replacement owner's completion boundary. */
export async function refreshJournalDerivedRead(
  journal: AgentSessionJournal,
  refresh: () => Promise<void>
): Promise<void> {
  refreshing.add(journal)
  try {
    await refresh()
  } finally {
    refreshing.delete(journal)
  }
}

export function readJournalDerived<T>(
  journal: AgentSessionJournal,
  read: (finite: boolean) => Generator<void, T>
): T | Promise<T> {
  return refreshing.has(journal)
    ? journal.readInOrder(() => finishJournalStepsAsync(read(true)))
    : finishJournalSteps(read(false))
}
