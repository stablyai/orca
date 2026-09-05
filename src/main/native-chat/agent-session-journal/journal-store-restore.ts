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
import { deleteJournalRepairedSuffix } from './journal-repair-marker'

export function restoreJournalStore(
  host: JournalStoreHost,
  collaborators: { epochController: JournalEpochController }
): Promise<void> {
  return openJournalStoreState({
    journalDir: host.journalDir,
    loaded: host.loaded(),
    replay: () => {
      const opened = host.database()
      return replayJournal(opened.db, opened.readOnly, host.identity.sessionId)
    },
    deleteSuffix: (fromSeq, contentFrom) =>
      deleteJournalRepairedSuffix({
        db: host.database().db,
        sessionId: host.identity.sessionId,
        epoch: host.state().epoch,
        fromSeq,
        contentFrom,
        now: host.now()
      }),
    start: () => collaborators.epochController.start('session_created', 0),
    // `unreconcilable_prefix` is the durable statement that this epoch exists
    // because a repair emptied one: replay reads it back and keeps asking for
    // provider history until the timeline is rebuilt or the session writes.
    publishRepairEpoch: () =>
      collaborators.epochController.start('unreconcilable_prefix', host.state().highestFence),
    adopt: host.adopt,
    appendDisclosure: (identity, body, fence) =>
      host.journal().appendItem(identity, body, { fence }),
    highestFence: () => host.state().highestFence,
    malformedRows: host.malformedRows,
    setMalformedRows: host.setMalformedRows,
    readOnly: host.readOnly
  })
}
