// Wiring for the store's collaborators.
//
// Split out of the store itself so the class stays a description of the public
// surface rather than sixty lines of constructor plumbing.

import type {
  AgentJournalCursor,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type { JournalHostDatabase } from './journal-host-database'
import { JournalEpochController } from './journal-epoch-controller'
import { JournalItemAppender } from './journal-item-appender'
import { JournalLifecycleBatchAppender } from './journal-lifecycle-batch-appender'
import type { JournalLoad } from './journal-open'
import { JournalQueuedMessages } from './journal-queued-messages'
import { journalQueuePauseRestatement } from './queued-message-pause'
import type { JournalReducerState } from './journal-reducer'
import { JournalRowWriter } from './journal-row-writer'
import { restoreJournalStore } from './journal-store-restore'
import type { JournalRow } from './journal-row-schema'
import type { AgentSessionJournal } from './journal-store'

export type JournalStoreHost = {
  /** Fires the journal's commit listener for a durable change that appended no
   *  row — a standalone draft-table transaction — so readers learn of it the
   *  same way they learn of a row. */
  notifyCommitted: () => void
  identity: AgentSessionJournalIdentity
  /** Where the chat's per-chat history lived, for the importer and the format-remnant notice. */
  legacyDirectory: string
  now: () => number
  mintEpoch: () => string
  serialize: <T>(run: () => Promise<T>) => Promise<T>
  /** Leave a chat still in its per-chat file uncopied until its first use. */
  deferPerSessionImport: boolean
  /** Work the chat's next write waits for. */
  owe: (work: () => Promise<void>) => void
  database: () => JournalHostDatabase
  state: () => JournalReducerState
  readOnly: () => boolean
  setReadOnly: (readOnly: boolean) => void
  cursor: () => AgentJournalCursor
  adopt: (loaded: JournalLoad) => void
  commit: (row: JournalRow) => void
  /** Records whether the open's replay found an unusable prefix. */
  setOpenedCorrupt: (corrupt: boolean) => void
  malformedRows: () => number
  setMalformedRows: (count: number) => void
  journal: () => AgentSessionJournal
  enqueue: (build: (seq: number, ts: number) => JournalRow) => Promise<JournalRow>
}

export type JournalStoreCollaborators = {
  rowWriter: JournalRowWriter
  epochController: JournalEpochController
  itemAppender: JournalItemAppender
  lifecycleBatchAppender: JournalLifecycleBatchAppender
  queuedMessages: JournalQueuedMessages
  /** Restores the store's state from disk. Owned here because it needs the same
   *  collaborators the constructor just built. */
  restore: () => Promise<void>
}

export function createJournalStoreCollaborators(host: JournalStoreHost): JournalStoreCollaborators {
  const epochController = new JournalEpochController({
    identity: host.identity,
    now: host.now,
    mintEpoch: host.mintEpoch,
    serialize: host.serialize,
    database: host.database,
    readOnly: host.readOnly,
    setReadOnly: host.setReadOnly,
    highestFence: () => host.state().highestFence,
    queuePauseRestatement: () =>
      journalQueuePauseRestatement(
        host.state().queuePauseMarks,
        host.state().latestPersonTurnSequence
      ),
    cursor: host.cursor,
    adopt: host.adopt
  })
  const queuedMessages = new JournalQueuedMessages({
    sessionId: host.identity.sessionId,
    now: host.now,
    serialize: host.serialize,
    database: host.database,
    readOnly: host.readOnly,
    state: host.state,
    wroteBeforeOpen: (sequence) => host.journal().wroteBeforeOpen(sequence),
    committed: host.notifyCommitted
  })
  return {
    epochController,
    queuedMessages,
    // Behind the stored fact: settles drafts whose consumed submission the loaded journal shows
    // refused (a downgrade wrote no hook), then prunes. Bookkeeping, never failing the open.
    restore: () =>
      restoreJournalStore(host, { epochController }).then(() =>
        queuedMessages.repairAndPruneAtOpen()
      ),
    rowWriter: new JournalRowWriter({
      sessionId: host.identity.sessionId,
      now: host.now,
      serialize: host.serialize,
      database: host.database,
      readOnly: host.readOnly,
      highestFence: () => host.state().highestFence,
      nextSequence: () => host.state().lastSequence + 1,
      commit: host.commit,
      // Every rejection is a dispatch row through this one writer; the draft
      // returned-transition rides it so no path can bypass the hook.
      inTransaction: (db, row) => queuedMessages.onRowInTransaction(db, row),
      rolledBack: () => queuedMessages.invalidate()
    }),
    itemAppender: new JournalItemAppender({
      state: host.state,
      enqueue: host.enqueue
    }),
    lifecycleBatchAppender: new JournalLifecycleBatchAppender({
      state: host.state,
      cursor: host.cursor,
      enqueue: host.enqueue
    })
  }
}
