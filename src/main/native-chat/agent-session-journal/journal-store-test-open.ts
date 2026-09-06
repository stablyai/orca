// Shared tracked-open helper for journal tests.
//
// Tracking every opened INSTANCE rather than a variable is the point: `close()`
// is idempotent, a module-level `journal` binding can be reassigned to a second
// store mid-suite, and `allSettled` means one failing close cannot skip the rest
// or the directory removal behind it.

import type { AgentSessionJournal } from './journal-store'
import type { AgentSessionJournalOptions } from './journal-store-contracts'
import { openAgentSessionJournal } from './journal-store-factory'

export type TrackedJournalOpener = {
  open: (options: AgentSessionJournalOptions) => Promise<AgentSessionJournal>
  track: <T extends AgentSessionJournal>(journal: T) => T
  closeAll: () => Promise<void>
}

export function createTrackedJournalOpener(): TrackedJournalOpener {
  const opened: AgentSessionJournal[] = []
  return {
    open: async (options) => {
      const journal = await openAgentSessionJournal(options)
      opened.push(journal)
      return journal
    },
    track: (journal) => {
      opened.push(journal)
      return journal
    },
    closeAll: async () => {
      await Promise.allSettled(opened.splice(0).map((journal) => journal.close()))
    }
  }
}
