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
import { JournalStopMarks } from './journal-stop-marks'
import { journalQueuePauseRestatement } from './queued-message-pause'
import type { JournalReducerState } from './journal-reducer'
import { JournalRowWriter } from './journal-row-writer'
import { restoreJournalStore } from './journal-store-restore'
import type { JournalRow } from './journal-row-schema'
import type { AgentSessionJournal } from './journal-store'
import type Database from '../../sqlite/sync-database'
import { applyJournalRow } from './journal-reducer'
import { journalRowsAfterReader } from './journal-open'
import { readJournalSince } from './journal-cursor'
import type { JournalReadSince } from './journal-store-contracts'
import { JOURNAL_REPAIR_DISCLOSURE_ITEM_ID } from './journal-repair-disclosure'
import {
  deriveJournalSessionStatus,
  hasJournalSessionStatus,
  writeJournalSessionStatus
} from './journal-session-state'
import { JournalStatusProjection } from './journal-status-projection'
import { beginJournalFoldUndo, type JournalFoldUndo } from './journal-fold-undo'
import type { JournalWriteBody } from './journal-write-queue'

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
  serialize: <T>(run: JournalWriteBody<T>) => Promise<T>
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
  /** That re-read failed too: the fold is re-read before its next use, never served as it is. */
  markFoldStale: () => void
  /** Whether a fresh replay would report the history corrupt. */
  loadCorrupt: () => boolean
  setLoadCorrupt: (corrupt: boolean) => void
  /** The conversation's fence, which the stored status reads as the status feed does. */
  currentFence: () => number | undefined
  /** A per-chat file's copy is still owed: the fold is not the database's yet. */
  importPending: () => boolean
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
  stopMarks: JournalStopMarks
  /** Restores the store's state from disk. Owned here because it needs the same
   *  collaborators the constructor just built. */
  restore: () => Promise<void>
  /** Writes the chat's status if it has none: a chat an older build last wrote. */
  backfillSessionStatus: () => void
  readSince: (cursor: AgentJournalCursor, limit?: number) => JournalReadSince
  statusProjection: JournalStatusProjection
}

export function createJournalStoreCollaborators(host: JournalStoreHost): JournalStoreCollaborators {
  const statusProjection = new JournalStatusProjection(host.state)
  /** `live`: the store's own fold, whose projection the status feed shares; an epoch's new fold
   *  projects its own. Decided by the caller, so nothing reads the store's fold inside the
   *  transaction. */
  const writeStatus = (
    db: Database.Database,
    state: JournalReducerState,
    corrupt: boolean,
    live: boolean
  ) =>
    writeJournalSessionStatus(
      db,
      host.identity.sessionId,
      deriveJournalSessionStatus(state, {
        settlesRosters: !corrupt,
        currentFence: host.currentFence(),
        ...(live ? { statusSummary: () => statusProjection.at(host.currentFence()).summary } : {})
      })
    )
  // The open append's undo: what its row changed in the fold, put back if its transaction fails.
  let undo: JournalFoldUndo | null = null
  // Any row but the repair's own disclosure retires the rebuild a repair owed, as replay reads it.
  const corruptAfter = (row: JournalRow) =>
    host.loadCorrupt() && row.kind === 'item' && row.itemId === JOURNAL_REPAIR_DISCLOSURE_ITEM_ID
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
    adopt: (loaded) => {
      host.setLoadCorrupt(loaded.corrupt)
      host.adopt(loaded)
    },
    writeState: (db, state, corrupt) => writeStatus(db, state, corrupt, false)
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
    statusProjection,
    backfillSessionStatus: () => backfillSessionStatus(host, writeStatus),
    // Here rather than on the store, which is at its length limit.
    readSince: (cursor, limit) =>
      readJournalSince(
        {
          state: host.state(),
          rowsAfter: journalRowsAfterReader(
            host.database().db,
            host.identity.sessionId,
            host.state().epoch,
            limit
          ),
          readOnly: host.readOnly()
        },
        cursor,
        host.cursor
      ),
    stopMarks: new JournalStopMarks({ state: host.state }),
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
      apply: (row) => {
        undo = beginJournalFoldUndo(host.state())
        applyJournalRow(host.state(), row)
      },
      writeStatus: (db, row) => writeStatus(db, host.state(), corruptAfter(row), true),
      committed: (row) => {
        undo?.commit()
        undo = null
        host.setLoadCorrupt(corruptAfter(row))
        host.notifyCommitted()
      },
      recoverFold: () => {
        // What the projection read of the failed row must not answer for the next one at its seq.
        statusProjection.invalidate()
        const failed = undo
        undo = null
        recoverJournalFold(host, failed)
      },
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

/** Bookkeeping: a failure leaves the chat without a row, which its next open writes again. */
function backfillSessionStatus(
  host: JournalStoreHost,
  writeStatus: (
    db: Database.Database,
    state: JournalReducerState,
    corrupt: boolean,
    live: boolean
  ) => void
): void {
  const database = host.database()
  if (host.readOnly() || database.readOnly || host.importPending()) {
    return
  }
  try {
    // Read before the transaction: a stale fold is re-read from disk, never inside one.
    const state = host.state()
    database.transaction((db) => {
      if (!hasJournalSessionStatus(db, host.identity.sessionId)) {
        writeStatus(db, state, host.loadCorrupt(), true)
      }
    })
  } catch (error) {
    console.warn('[agent-session-journal] writing a chat status failed', {
      sessionId: host.identity.sessionId,
      error
    })
  }
}

/**
 * An append whose transaction failed after its row was folded: the undo puts back what the row
 * changed. If it cannot (it throws, or the row removed an entry, which no undo puts back in its
 * place), the fold is marked stale and folded again from what committed before its next use (the
 * host database rolls a stranded transaction back before it hands out the connection, so that
 * re-read never sees the failed row).
 */
function recoverJournalFold(host: JournalStoreHost, undo: JournalFoldUndo | null): void {
  try {
    if (undo?.rollback()) {
      return
    }
  } catch (error) {
    console.warn('[agent-session-journal] undoing a failed append failed', {
      sessionId: host.identity.sessionId,
      error
    })
  }
  host.markFoldStale()
}
