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
import { JournalStepWriter } from './journal-step-writer'
import { restoreJournalStore } from './journal-store-restore'
import { JournalSubmissionWriter } from './journal-submission-writer'
import type { JournalRow } from './journal-row-schema'
import type { AgentSessionJournal } from './journal-store'
import type { JournalWriteBody } from './journal-write-queue'
import type { JournalAttachmentClaim } from './journal-submission-hook'
import { claimAgentSessionAttachmentsInTransaction } from '../agent-session-attachments/agent-session-attachment-claims'
import { JournalReopenedLiveWork } from './journal-reopened-live-work'

export type JournalStoreHost = {
  /** Fires the journal's commit listener for a durable change that appended no
   *  row — a standalone draft-table transaction — so readers learn of it the
   *  same way they learn of a row. */
  notifyCommitted: () => void
  identity: AgentSessionJournalIdentity
  now: () => number
  mintEpoch: () => string
  serialize: <T>(run: JournalWriteBody<T>) => Promise<T>
  database: () => JournalHostDatabase
  state: () => JournalReducerState
  readOnly: () => boolean
  cursor: () => AgentJournalCursor
  adopt: (loaded: JournalLoad) => void
  commit: (row: JournalRow) => void
  journal: () => AgentSessionJournal
  enqueue: (build: (seq: number, ts: number) => JournalRow) => Promise<JournalRow>
}

export type JournalStoreCollaborators = {
  rowWriter: JournalRowWriter
  epochController: JournalEpochController
  itemAppender: JournalItemAppender
  lifecycleBatchAppender: JournalLifecycleBatchAppender
  submissionWriter: JournalSubmissionWriter
  stepWriter: JournalStepWriter
  queuedMessages: JournalQueuedMessages
  stopMarks: JournalStopMarks
  reopenedLiveWork: JournalReopenedLiveWork
  /** Restores the store's state from disk. Owned here because it needs the same
   *  collaborators the constructor just built. */
  restore: () => Promise<void>
}

export function createJournalStoreCollaborators(host: JournalStoreHost): JournalStoreCollaborators {
  const reopenedLiveWork = new JournalReopenedLiveWork({
    sessionId: host.identity.sessionId,
    state: host.state,
    journal: host.journal
  })
  const epochController = new JournalEpochController({
    identity: host.identity,
    now: host.now,
    mintEpoch: host.mintEpoch,
    serialize: host.serialize,
    database: host.database,
    readOnly: host.readOnly,
    highestFence: () => host.state().highestFence,
    queuePauseRestatement: () =>
      journalQueuePauseRestatement(
        host.state().queuePauseMarks,
        host.state().latestAcceptedTurnSequence,
        host.journal().queuedMessages.pauses()
      ),
    cursor: host.cursor,
    adopt: host.adopt
  })
  const claimAttachments: JournalAttachmentClaim = (db, body, required) =>
    claimAgentSessionAttachmentsInTransaction(db, {
      // Uploaded attachments are stored beside the journal database.
      stateDirectory: host.database().stateDirectory,
      sessionId: host.identity.sessionId,
      body,
      required,
      now: host.now()
    })
  const queuedMessages = new JournalQueuedMessages({
    sessionId: host.identity.sessionId,
    now: host.now,
    serialize: host.serialize,
    database: host.database,
    readOnly: host.readOnly,
    state: host.state,
    reopenFloor: () => host.journal().reopenFloor(),
    committed: host.notifyCommitted,
    claimAttachments
  })
  const rowWriter = new JournalRowWriter({
    sessionId: host.identity.sessionId,
    now: host.now,
    serialize: host.serialize,
    database: host.database,
    readOnly: host.readOnly,
    highestFence: () => host.state().highestFence,
    nextSequence: () => host.state().lastSequence + 1,
    commit: (row) => {
      host.commit(row)
      reopenedLiveWork.afterCommit()
    },
    // Every rejection is a dispatch row through this one writer; the draft
    // returned-transition rides it so no path can bypass the hook.
    inTransaction: (db, row) => queuedMessages.onRowInTransaction(db, row),
    rolledBack: () => queuedMessages.invalidate()
  })
  const lifecycleBatchAppender = new JournalLifecycleBatchAppender({
    state: host.state,
    cursor: host.cursor,
    enqueue: host.enqueue,
    enqueueRows: (plan) => rowWriter.enqueueRows(plan)
  })
  return {
    epochController,
    queuedMessages,
    reopenedLiveWork,
    stopMarks: new JournalStopMarks({ state: host.state }),
    // Behind the stored fact: settles drafts whose consumed submission the loaded journal shows
    // refused (a downgrade wrote no hook), then prunes. Bookkeeping, never failing the open.
    restore: () =>
      restoreJournalStore(host, { epochController, reopenedLiveWork }).then(() =>
        queuedMessages.repairAndPruneAtOpen()
      ),
    rowWriter,
    submissionWriter: new JournalSubmissionWriter({
      state: host.state,
      identity: host.identity,
      rowWriter,
      queuedMessages,
      claimAttachments
    }),
    itemAppender: new JournalItemAppender({
      state: host.state,
      enqueue: host.enqueue
    }),
    lifecycleBatchAppender,
    stepWriter: new JournalStepWriter({
      serialize: host.serialize,
      state: host.state,
      writeRows: (plan) => rowWriter.writeRows(plan),
      planSettlement: (batch) => lifecycleBatchAppender.planResolved(batch)
    })
  }
}
