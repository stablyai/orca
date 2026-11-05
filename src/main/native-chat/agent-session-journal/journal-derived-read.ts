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
    ? readJournalDerivedInOrder(journal, read, current)
    : finishJournalSteps(read(false))
}

/** Request reads include earlier admitted writes; committed notification paths remain immediate. */
export function readJournalDerivedInOrder<T>(
  journal: AgentSessionJournal,
  read: (finite: boolean) => Generator<void, T>,
  current: () => boolean = () => true
): Promise<T> {
  const finite = refreshing.has(journal)
  return journal.readInOrder(async () => {
    if (!current()) {
      throw new Error('Journal read superseded')
    }
    const prepare = finite || refreshing.has(journal)
    const result = prepare
      ? await finishJournalStepsAsync(read(true))
      : finishJournalSteps(read(false))
    if (!current()) {
      throw new Error('Journal read superseded')
    }
    return result
  })
}
