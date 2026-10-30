import type {
  AgentJournalCursor,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type { JournalHostDatabase } from './journal-host-database'
import { JournalContextController } from './journal-context-controller'
import { JournalEpochController } from './journal-epoch-controller'
import { JournalItemAppender } from './journal-item-appender'
import { JournalLifecycleBatchAppender } from './journal-lifecycle-batch-appender'
import type { JournalLoad } from './journal-open'
import { JournalQueuedMessages } from './journal-queued-messages'
import { JournalStopMarks } from './journal-stop-marks'
import { JournalStopAcceptor } from './journal-stop-acceptance'
import { journalQueuePauseRestatement } from './queued-message-pause'
import type { JournalReducerState } from './journal-reducer'
import { JournalRowWriter, type JournalOperationReceipt } from './journal-row-writer'
import { JournalStepWriter } from './journal-step-writer'
import { restoreJournalStore } from './journal-store-restore'
import { JournalSubmissionWriter } from './journal-submission-writer'
import type { JournalRow } from './journal-row-schema'
import type { AgentSessionJournal } from './journal-store'
import type { JournalWriteBody } from './journal-write-queue'
import { journalInputClaimsReceipt, type JournalAttachmentClaim } from './journal-submission-hook'
import { claimAgentSessionAttachmentsInTransaction } from '../agent-session-attachments/agent-session-attachment-claims'
import { JournalGoalAttachmentInverse } from './journal-goal-attachment-inverse'
import { isJournalStreamedTextRevision } from './journal-streamed-text-revision'

export type JournalStoreHost = {
  /** Notify readers of durable draft-only transactions that append no journal row. */
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
  commit: (rows: readonly JournalRow[], savedAt: number) => void
  journal: () => AgentSessionJournal
  enqueue: JournalRowWriter['enqueue']
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
  context: JournalContextController
  stops: JournalStopAcceptor
  goalAttachments: JournalGoalAttachmentInverse
  restore: () => Promise<void>
}

export function createJournalStoreCollaborators(host: JournalStoreHost): JournalStoreCollaborators {
  const goalAttachments = new JournalGoalAttachmentInverse(host.identity.sessionId)
  const claimAttachments: JournalAttachmentClaim = (db, body, required, previous, goalId) => {
    const claim = claimAgentSessionAttachmentsInTransaction(db, {
      stateDirectory: host.database().stateDirectory,
      sessionId: host.identity.sessionId,
      body,
      required,
      ...(previous ? { previous } : {}),
      now: host.now()
    })
    return () => goalAttachments.acquired(claim.referenced, claim.inserted, goalId)
  }
  const epochController = new JournalEpochController({
    claimAttachments,
    isLiveGoal: (id) => goalAttachments.isLive(id),
    identity: host.identity,
    now: host.now,
    mintEpoch: host.mintEpoch,
    serialize: host.serialize,
    database: host.database,
    readOnly: host.readOnly,
    highestFence: () => host.state().highestFence,
    state: host.state,
    queuePauseRestatement: () =>
      journalQueuePauseRestatement(
        host.state().queuePauseMarks,
        host.state().latestAcceptedTurnSequence,
        host.journal().queuedMessages.pauses()
      ),
    queueRestatement: () => host.journal().queuedMessages.restatement(),
    cursor: host.cursor,
    adopt: host.adopt
  })
  const rowWriter = new JournalRowWriter({
    sessionId: host.identity.sessionId,
    now: host.now,
    serialize: host.serialize,
    database: host.database,
    readOnly: host.readOnly,
    highestFence: () => host.state().highestFence,
    nextSequence: () => host.state().lastSequence + 1,
    commit: host.commit,
    streamedTextRevision: (row) => isJournalStreamedTextRevision(host.state(), row)
  })
  const inputReceipt = (rows: readonly JournalRow[], receipt?: JournalOperationReceipt) =>
    journalInputClaimsReceipt(claimAttachments, (id) => goalAttachments.isLive(id), rows, receipt)
  const queuedMessages = new JournalQueuedMessages({
    sessionId: host.identity.sessionId,
    serialize: host.serialize,
    database: host.database,
    readOnly: host.readOnly,
    state: host.state,
    reopenFloor: () => host.journal().reopenFloor(),
    writer: rowWriter,
    committed: host.notifyCommitted,
    claimAttachments
  })
  const lifecycleBatchAppender = new JournalLifecycleBatchAppender({
    state: host.state,
    cursor: host.cursor,
    enqueueRows: (plan) => rowWriter.enqueueRows(plan, inputReceipt)
  })
  return {
    goalAttachments,
    epochController,
    queuedMessages,
    stopMarks: new JournalStopMarks({ state: host.state }),
    context: new JournalContextController({
      state: host.state,
      writer: rowWriter,
      cards: queuedMessages
    }),
    stops: new JournalStopAcceptor({ writer: rowWriter, state: host.state }),
    // Import legacy cards once per open without failing the open.
    restore: () =>
      restoreJournalStore(host, { epochController }).then(() => queuedMessages.importAtOpen()),
    rowWriter,
    submissionWriter: new JournalSubmissionWriter({
      state: host.state,
      identity: host.identity,
      rowWriter,
      queuedMessages,
      claimAttachments
    }),
    itemAppender: new JournalItemAppender({
      inputReceipt,
      state: host.state,
      enqueue: host.enqueue,
      claimAttachments
    }),
    lifecycleBatchAppender,
    stepWriter: new JournalStepWriter({
      serialize: host.serialize,
      state: host.state,
      writeRows: (plan) => rowWriter.writeRows(plan, inputReceipt),
      planSettlement: (batch) => lifecycleBatchAppender.planResolved(batch)
    })
  }
}
