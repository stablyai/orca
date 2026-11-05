import type { AgentSessionJournal } from './journal-store'
import { finishJournalSteps, finishJournalStepsAsync } from './journal-reconstruction-steps'

const refreshing = new WeakMap<AgentSessionJournal, number>()

export const journalDerivedRefreshPending = (journal: AgentSessionJournal): boolean =>
  refreshing.has(journal)

/** Every current derived reader shares the replacement owner's completion boundary. */
export async function refreshJournalDerivedRead(
  journal: AgentSessionJournal,
  refresh: () => Promise<void>
): Promise<void> {
  refreshing.set(journal, (refreshing.get(journal) ?? 0) + 1)
  try {
    await refresh()
  } finally {
    const depth = refreshing.get(journal)! - 1
    if (depth) {
      refreshing.set(journal, depth)
    } else {
      refreshing.delete(journal)
    }
  }
}

export function readJournalDerived<T>(
  journal: AgentSessionJournal,
  read: (finite: boolean) => Generator<void, T>,
  current: () => boolean = () => true
): T | Promise<T> {
  return refreshing.has(journal)
    ? journal.readInOrder(async () => {
        if (!current()) {
          throw new Error('Journal read superseded')
        }
        const result = await finishJournalStepsAsync(read(true))
        if (!current()) {
          throw new Error('Journal read superseded')
        }
        return result
      })
    : finishJournalSteps(read(false))
}
