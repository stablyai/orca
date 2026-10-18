// Bringing a store's in-memory state up from disk. It writes only a fresh first epoch, for a chat
// with no journal yet or whose saved epoch holds no row: what a gone writer left live is settled by
// the ownership event that ended it, never by this open.

import type { JournalEpochController } from './journal-epoch-controller'
import { replayJournal } from './journal-open'
import { journalOpenRefusalError } from './journal-open-failure'
import type { JournalStoreHost } from './journal-store-collaborators'
import { openJournalStoreState } from './journal-store-open'
import { AgentSessionJournalError } from './journal-write-guards'

export async function restoreJournalStore(
  host: JournalStoreHost,
  collaborators: { epochController: JournalEpochController }
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
    start: () => collaborators.epochController.start('session_created', 0),
    adopt: host.adopt
  })
}
