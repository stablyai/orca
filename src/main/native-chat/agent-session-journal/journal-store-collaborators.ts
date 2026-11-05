import { prepareJournalRunningTurnSteps } from './journal-public-read'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { finishJournalStepsAsync, sortJournalSteps } from './journal-reconstruction-steps'
import { journalInputOrder } from './journal-input-order'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session/requests/agent-session-queued-submission'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalCursor,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalHostDatabase } from './journal-host-database'
import { JournalContextController } from './journal-context-controller'
import { JournalEpochController } from './journal-epoch-controller'
import { JournalItemAppender } from './journal-item-appender'
import { JournalLifecycleBatchAppender } from './journal-lifecycle-batch-appender'
import type { JournalLoad } from './journal-open'
import { JournalQueuedMessages } from './journal-queued-messages'
import { JournalStopMarks } from './journal-stop-marks'
import { JournalStopAcceptor } from './journal-stop-acceptance'
import { projectJournalRowSteps } from './journal-context-cursor'
import type { JournalReducerState } from './journal-reducer'
import { JournalRowWriter, type JournalOperationReceipt } from './journal-row-writer'
import { JournalStepWriter } from './journal-step-writer'
import { restoreJournalStore } from './journal-store-restore'
import { JournalSubmissionWriter } from './journal-submission-writer'
import type { JournalRow } from './journal-row-schema'
import type { AgentSessionJournal } from './journal-store'
import type { JournalWriteBody } from './journal-write-queue'
import {
  journalInputClaimsReceipt,
  journalInputClaimsReceiptSteps,
  journalAttachmentClaimsReceipt,
  type JournalAttachmentClaim
} from './journal-submission-hook'
import { prepareAgentSessionAttachmentClaim } from '../agent-session-attachments/agent-session-attachment-claims'
import { JournalGoalAttachmentInverse } from './journal-goal-attachment-inverse'
import {
  isJournalOutputRevision,
  isJournalStreamedTextRevision
} from './journal-streamed-text-revision'

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
  adopt: (loaded: JournalLoad) => void | Promise<void>
  publish: () => void
  verify: () => Promise<void>
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
  const claimAttachments: JournalAttachmentClaim = async (db, body, required, previous, goalId) => {
    const claim = await prepareAgentSessionAttachmentClaim({
      stateDirectory: host.database().stateDirectory,
      sessionId: host.identity.sessionId,
      body,
      required,
      ...(previous ? { previous } : {}),
      now: host.now()
    })
    let acquired: { referenced: Set<string>; inserted: string[] } | undefined
    db.add({ kind: 'claim', claim }, (result) => {
      if (typeof result !== 'object' || !result || !('referenced' in result)) {
        throw new Error('journal attachment claim result is missing')
      }
      acquired = result
    })
    return () => {
      if (!acquired) {
        throw new Error('journal attachment claim did not settle')
      }
      goalAttachments.acquired(acquired.referenced, acquired.inserted, goalId)
    }
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
    preparePublication: async (state) => {
      await queuedMessages.listAsync(state)
      await finishJournalStepsAsync(prepareJournalRunningTurnSteps(state))
    },
    commit: host.commit,
    verify: host.verify,
    projectSteps: (rows) => projectJournalRowSteps(host.state(), rows),
    streamedTextRevision: (row) => isJournalStreamedTextRevision(host.state(), row),
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
  const rewindReceipt = async (rows: readonly JournalRow[], receipt?: JournalOperationReceipt) => {
    const state = host.state()
    const order = journalInputOrder(state)
    const cards = await queuedMessages.listAsync()
    const bodies = await finishJournalStepsAsync(
      (function* () {
        const bodies: AgentJournalMessageItem[] = []
        for (const card of cards) {
          bodies.push(card.body)
          yield
        }
        const pending = yield* sortJournalSteps(
          order.recoverableSubmissionValues(),
          (a, b) => order.inputOrdinal(a.clientMessageId) - order.inputOrdinal(b.clientMessageId)
        )
        for (const submission of pending) {
          yield
          if (!isQueuedAgentJournalSubmission(submission)) {
            continue
          }
          const body = state.items.get(agentJournalSubmissionKey(submission.clientMessageId))?.body
          if (body?.kind !== 'message') {
            throw new Error('journal_queued_submission_body_missing')
          }
          bodies.push(body)
        }
        return bodies
      })()
    )
    return finishJournalStepsAsync(
      journalInputClaimsReceiptSteps(
        claimAttachments,
        (id) => goalAttachments.isLive(id),
        rows,
        journalAttachmentClaimsReceipt(claimAttachments, bodies, receipt)
      )
    )
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
    adopt: host.adopt,
    publish: host.publish
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
    stops: new JournalStopAcceptor({ now: host.now, writer: rowWriter, state: host.state }),
    // Import legacy cards once per open without failing the open.
    restore: () =>
      queuedMessages
        .initialize()
        .then(() => restoreJournalStore(host, { epochController }))
        .then(() => queuedMessages.importAtOpen()),
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
      append: rowWriter.append.bind(rowWriter),
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
