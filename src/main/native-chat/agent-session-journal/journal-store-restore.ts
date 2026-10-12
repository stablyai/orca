// Bringing a store's in-memory state up from disk. It reads and never writes: a chat with no
// journal yet gets an empty one held in memory (`journal-epoch-founding.ts`), and what a gone
// writer left live is settled by the ownership event that ended it, never by this open.

import type { JournalEpochFounding } from './journal-epoch-founding'
import { replayJournal } from './journal-open'
import { journalOpenRefusalError } from './journal-open-failure'
import type { JournalStoreHost } from './journal-store-collaborators'
import { openJournalStoreState } from './journal-store-open'
import { AgentSessionJournalError } from './journal-write-guards'

export async function restoreJournalStore(
  host: JournalStoreHost,
  founding: Pick<JournalEpochFounding, 'hold'>
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
  openJournalStoreState({
    sessionId: host.identity.sessionId,
    replay: () => replayJournal(database.db, host.identity.sessionId),
    start: () => host.adopt(founding.hold(host.mintEpoch(), host.now())),
    adopt: host.adopt
  })
}
