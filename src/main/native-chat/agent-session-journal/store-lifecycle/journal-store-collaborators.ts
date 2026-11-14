import { journalInputOrder } from '../input-order/journal-input-order'
import { isQueuedAgentJournalSubmission } from '../../../../shared/agent-session/requests/agent-session-queued-submission'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalCursor,
  AgentSessionJournalIdentity
} from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalHostDatabase } from '../database/journal-host-database'
import { JournalContextController } from '../context-epochs/journal-context-controller'
import { JournalEpochController } from '../context-epochs/journal-epoch-controller'
import { JournalItemAppender } from '../writing/journal-item-appender'
import { JournalLifecycleBatchAppender } from '../writing/journal-lifecycle-batch-appender'
import type { JournalLoad } from '../replay/journal-open'
import { JournalQueuedMessages } from '../queued-messages/journal-queued-messages'
import { JournalStopMarks } from '../context-epochs/journal-stop-marks'
import { JournalStopAcceptor } from '../context-epochs/journal-stop-acceptance'
import { projectJournalRows } from '../context-epochs/journal-context-cursor'
import type { JournalReducerState } from '../projection/journal-reducer'
import { JournalRowWriter, type JournalOperationReceipt } from '../writing/journal-row-writer'
import { JournalStepWriter } from '../writing/journal-step-writer'
import { restoreJournalStore } from './journal-store-restore'
import { JournalSubmissionWriter } from '../submissions/journal-submission-writer'
import type { JournalRow } from '../durable-rows/journal-row-schema'
import type { AgentSessionJournal } from '../journal-store'
import type { JournalWriteBody } from '../writing/journal-write-queue'
import {
  journalInputClaimsReceipt,
  journalAttachmentClaimsReceipt,
  type JournalAttachmentClaim
} from '../submissions/journal-submission-hook'
import { claimAgentSessionAttachmentsInTransaction } from '../../agent-session-attachments/agent-session-attachment-claims'
import { JournalGoalAttachmentInverse } from '../writing/journal-goal-attachment-inverse'
import { isJournalOutputRevision } from '../writing/journal-streamed-text-revision'

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
  prepare: NonNullable<ConstructorParameters<typeof JournalRowWriter>[0]['prepare']>
  commit: ConstructorParameters<typeof JournalRowWriter>[0]['commit']
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
  const rowWriter = new JournalRowWriter({
    sessionId: host.identity.sessionId,
    now: host.now,
    serialize: host.serialize,
    database: host.database,
    readOnly: host.readOnly,
    highestFence: () => host.state().highestFence,
    nextSequence: () => host.state().lastSequence + 1,
    prepare: host.prepare,
    commit: host.commit,
    project: (rows) => projectJournalRows(host.state(), rows),
    outputRevision: (row) => isJournalOutputRevision(host.state(), row)
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
  const rewindReceipt = (rows: readonly JournalRow[], receipt?: JournalOperationReceipt) => {
    const state = host.state()
    const pending = journalInputOrder(state)
      .recoverableSubmissions()
      .filter(isQueuedAgentJournalSubmission)
    const bodies = queuedMessages.list().map((card) => card.body)
    for (const submission of pending) {
      const body = state.items.get(agentJournalSubmissionKey(submission.clientMessageId))?.body
      if (body?.kind !== 'message') {
        throw new Error('journal_queued_submission_body_missing')
      }
      bodies.push(body)
    }
    return inputReceipt(rows, journalAttachmentClaimsReceipt(claimAttachments, bodies, receipt))
  }
  const epochController = new JournalEpochController({
    identity: host.identity,
    now: host.now,
    mintEpoch: host.mintEpoch,
    database: host.database,
    state: host.state,
    writer: rowWriter,
    inputReceipt: rewindReceipt,
    cards: queuedMessages,
    adopt: host.adopt
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
      cards: queuedMessages,
      inputReceipt: rewindReceipt
    }),
    stops: new JournalStopAcceptor({ writer: rowWriter, state: host.state }),
    // Import legacy cards once per open without failing the open.
    restore: () =>
      restoreJournalStore(host, { epochController }).then(() => queuedMessages.importAtOpen()),
    rowWriter,
    submissionWriter: new JournalSubmissionWriter({
      state: host.state,
      reopenFloor: () => host.journal().reopenFloor(),
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
