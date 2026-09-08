// Bringing a store's in-memory state up from disk.
//
// Split out of the store for the same reason its collaborators were: this is the
// ORDERING between replay, suffix repair and disclosure, and none of it belongs
// to the store's public surface. Every step here reads or writes through the
// same host the collaborators use, so the store keeps the state and this owns
// the sequence.

import type { JournalEpochController } from './journal-epoch-controller'
import { replayJournal } from './journal-open'
import type { JournalStoreHost } from './journal-store-collaborators'
import { openJournalStoreState } from './journal-store-open'
import { repairJournalGeneration } from './journal-repair-generation'

export function restoreJournalStore(
  host: JournalStoreHost,
  collaborators: { epochController: JournalEpochController }
): Promise<void> {
  return openJournalStoreState({
    journalDir: host.journalDir,
    loaded: host.database().readOnly ? undefined : host.loaded(),
    replay: () => {
      const opened = host.database()
      return replayJournal(opened.db, opened.readOnly, host.identity.sessionId)
    },
    repairGeneration: (loaded) =>
      repairJournalGeneration({
        db: host.database().db,
        identity: host.identity,
        loaded,
        epoch: host.mintEpoch(),
        now: host.now(),
        onPublished: host.adopt
      }),
    start: () => collaborators.epochController.start('session_created', 0),
    adopt: host.adopt,
    appendItem: (identity, body, fence) => host.journal().appendItem(identity, body, { fence }),
    agent: host.identity.agent,
    highestFence: () => host.state().highestFence,
    malformedRows: host.malformedRows,
    setMalformedRows: host.setMalformedRows,
    readOnly: host.readOnly
  })
}
