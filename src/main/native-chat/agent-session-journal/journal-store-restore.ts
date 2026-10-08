// Bringing a store's in-memory state up from disk.
//
// Split out of the store for the same reason its collaborators were: this is the
// ORDERING between replay and the notices an open owes, and none of it belongs
// to the store's public surface. Every step here reads or writes through the
// same host the collaborators use, so the store keeps the state and this owns
// the sequence.

import type { JournalEpochController } from './journal-epoch-controller'
import { replayJournal } from './journal-open'
import { journalOpenRefusalError } from './journal-open-failure'
import type { JournalStoreHost } from './journal-store-collaborators'
import { openJournalStoreState } from './journal-store-open'
import { AgentSessionJournalError } from './journal-write-guards'
import type { JournalReopenedLiveWork } from './journal-reopened-live-work'

export async function restoreJournalStore(
  host: JournalStoreHost,
  collaborators: {
    epochController: JournalEpochController
    reopenedLiveWork: JournalReopenedLiveWork
  }
): Promise<void> {
  const database = host.database()
  if (database.readOnly) {
    // A newer Orca's database: nothing in it is read as this build's, and nothing is written.
    throw journalOpenRefusalError(
      new AgentSessionJournalError(
        'journal_read_only',
        `agent-session journal for ${host.identity.sessionId} is in a newer Orca's database`
      )
    )
  }
  return openJournalStoreState({
    sessionId: host.identity.sessionId,
    replay: () => replayJournal(database.db, host.identity.sessionId),
    start: () => collaborators.epochController.start('session_created', 0),
    adopt: (loaded) => {
      collaborators.reopenedLiveWork.adopt(loaded)
      host.adopt(loaded)
    },
    settleReopenedLiveWork: () => collaborators.reopenedLiveWork.settle()
  })
}
