import * as journalInput from './journal-input-obligations'
import * as journalContext from './journal-context-cursor'
import { journalInputSourceBody } from './journal-input-source'
import { JournalHistoryReader } from './journal-history-read'

import { withJournalInputOrder } from './journal-input-provenance'
import { journalInputOrder } from './journal-input-order-owner'
import { finishJournalStepsAsync } from './journal-reconstruction-steps'
// Each session owns its fold and queue; all statements use the host's shared database connection.

import { JournalWriteProjection } from './journal-write-projection'
import type { AgentJournalDispatchRejection } from '../../../shared/agent-session/failures/agent-session-failure-words'
import { randomUUID } from 'node:crypto'
import { retireCoveredJournalFloor } from './journal-commit'
import * as journalPublic from './journal-public-read'
import type {
  AgentJournalItemBody,
  AgentJournalMessageItem,
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnLifecycle
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  AgentJournalItemIdentity,
  AgentJournalCursor,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import * as journalUsage from '../../../shared/agent-session/structured-agent-session-context-usage'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { journalWroteBeforeOpen } from './journal-cursor'
import type { JournalHostDatabase } from './journal-host-database'

import * as pendingRecovery from './journal-pending-submission-recovery'
import * as journalReducer from './journal-reducer'
import type {
  AgentSessionJournalOptions,
  JournalItemLinkageVisitor,
  JournalLifecycleBatchInput,
  JournalPlannedLifecycleBatchInput,
  JournalTombstoneInput
} from './journal-store-contracts'
import * as stopRows from './journal-stop-and-resume-rows'
import type { AgentJournalEpochReason, JournalStopEvent } from './journal-row-schema'
import type { JournalCommitObserver, JournalOperationReceipt } from './journal-row-writer'
import { JournalWriteQueue } from './journal-write-queue'
import { journalItemExecutionFence, journalItemProvenance } from './journal-item-provenance'
import { createJournalStoreCollaborators } from './journal-store-collaborators'
import * as journalGoal from './journal-thread-goal-source'
import { adoptJournalStoreState } from './journal-store-open'

type JournalCollaborators = ReturnType<typeof createJournalStoreCollaborators>

export class AgentSessionJournal {
  private readonly goalAttachments: JournalCollaborators['goalAttachments']
  private readonly identity: AgentSessionJournalIdentity
  private readonly database: JournalHostDatabase

  private state: journalReducer.JournalReducerState
  private readonly history: JournalHistoryReader
  private readonly readPublic = journalPublic.createJournalPublicReader(() => this.inputOrder)
  private openedThrough: AgentJournalCursor = { epoch: '', sequence: 0 }
  private reopenUnmarked: AgentJournalCursor | null = null
  private onCommitted: JournalCommitObserver | null = null
  private readonly queue: JournalWriteQueue
  private readonly rowWriter: JournalCollaborators['rowWriter']
  private readonly now: () => number
  private readonly epochController: JournalCollaborators['epochController']
  private readonly itemAppender: JournalCollaborators['itemAppender']
  private readonly lifecycleBatchAppender: JournalCollaborators['lifecycleBatchAppender']
  private readonly submissionWriter: JournalCollaborators['submissionWriter']
  private readonly stepWriter: JournalCollaborators['stepWriter']
  private readonly restore: () => Promise<void>
  private readonly projection: JournalWriteProjection
  /** Queued cards never count as owed work. */
  readonly queuedMessages: JournalCollaborators['queuedMessages']
  readonly stopMarks: JournalCollaborators['stopMarks']
  readonly stops: JournalCollaborators['stops']
  readonly context: JournalCollaborators['context']

  constructor(options: AgentSessionJournalOptions) {
    this.now = options.now ?? (() => Date.now())
    this.identity = options.identity
    this.database = options.database
    this.state = journalReducer.createJournalReducerState(options.identity.sessionId, '')
    this.history = new JournalHistoryReader(options, () => this.state, this.publicRead)
    this.readSinceView = this.history.readSinceView.bind(this.history)
    this.queue = new JournalWriteQueue(options.identity.sessionId)
    this.projection = new JournalWriteProjection({
      ...options,
      state: () => this.state,
      adopt: (state) => {
        this.stopMarks.reconcileReplacement(state)
        this.state = state
        this.reopenUnmarked = retireCoveredJournalFloor(state, this.reopenUnmarked)
      }
    })
    const collaborators = createJournalStoreCollaborators({
      identity: this.identity,
      now: this.now,
      mintEpoch: options.mintEpoch ?? randomUUID,
      serialize: (run) => this.queue.serialize(run),
      database: () => this.database,
      state: () => this.state,
      readOnly: () => this.database.readOnly,
      cursor: this.cursor,
      adopt: (loaded) =>
        adoptJournalStoreState(this.state, loaded, (state) => (this.state = state)),
      publish: () => this.onCommitted?.(),
      prepare: (db, rows, savedAt, finishFold, replacement) => {
        this.queuedMessages.inputState()
        return this.projection.prepare(db, rows, savedAt, finishFold, replacement)
      },
      commit: (rows, _savedAt, inputChanged, replacement) =>
        this.onCommitted?.(rows, inputChanged, replacement),
      verify: () => this.projection.verify(),
      notifyCommitted: () => this.onCommitted?.([]),
      journal: () => this,
      enqueue: (build, receipt) => this.rowWriter.enqueue(build, receipt)
    })
    this.rowWriter = collaborators.rowWriter
    this.epochController = collaborators.epochController
    this.goalAttachments = collaborators.goalAttachments
    this.itemAppender = collaborators.itemAppender
    this.lifecycleBatchAppender = collaborators.lifecycleBatchAppender
    this.submissionWriter = collaborators.submissionWriter
    this.stepWriter = collaborators.stepWriter
    this.queuedMessages = collaborators.queuedMessages
    this.stopMarks = collaborators.stopMarks
    this.stops = collaborators.stops
    this.restore = collaborators.restore
    this.context = collaborators.context
  }

  get epoch(): string {
    return journalContext.journalContextCursor(this.state).epoch
  }

  get agent(): AgentSessionJournalIdentity['agent'] {
    return this.identity.agent
  }

  get inputOrder() {
    return journalInputOrder(this.state)
  }

  withInputOrder<T>(ids: () => readonly string[], action: () => T): Promise<T> {
    return withJournalInputOrder(this.database, () => this.state, ids, action)
  }

  /** Only rows from this handle's opening epoch can predate the open. */
  wroteBeforeOpen(sequence: number | undefined): boolean {
    return journalWroteBeforeOpen(this.state, this.openedThrough, sequence)
  }

  /** Fallback reopen boundary until its mark is written; each new handle marks again. */
  reopenFloor(): AgentJournalCursor | null {
    return this.reopenUnmarked
  }

  async open(): Promise<void> {
    await this.restore()
    this.openedThrough = this.physicalCursor()
    await finishJournalStepsAsync(journalInputOrder(this.state).markOpeningRecoverySteps())
  }

  /** Refuse future writes and drain admitted ones; the host retains database ownership. */
  close(): Promise<void> {
    this.queuedMessages.editLeases.dispose()
    this.queue.markClosed()
    return this.queue.drain()
  }

  /** One nonthrowing listener; undefined rows mean adopted history, an empty array means metadata. */
  observeCommits(
    listener: (...args: Parameters<NonNullable<typeof this.onCommitted>>) => unknown
  ): () => void {
    const registered = (...args: Parameters<typeof listener>) => {
      const result = listener(...args)
      return result instanceof Promise ? result.then(() => {}) : undefined
    }
    this.onCommitted = registered
    return () => {
      if (this.onCommitted === registered) {
        this.onCommitted = null
      }
    }
  }

  cursor = (): AgentJournalCursor => journalContext.journalContextCursor(this.state)

  snapshot = () => this.publicRead().snapshot

  itemsRead = () => this.publicRead().snapshotForItems(new Set())

  currentRead = (inputIds?: readonly string[]) => this.publicRead().currentSnapshot(inputIds)

  statusRead = () =>
    journalPublic.renderJournalStatus(this.queuedMessages.displayState(), this.inputOrder)

  statusReadSteps = () =>
    journalPublic.renderJournalStatusSteps(this.queuedMessages.displayState(), this.inputOrder)

  preparePublicReadSteps = () => this.publicRead().prepareSteps()

  publicRead = () =>
    this.readPublic(this.state, this.queuedMessages.displayState(), this.queuedMessages.revision())

  /** Visit without allocating/sorting a snapshot. */
  visitItems = (
    visit: (itemId: string, sequence: number, body: AgentJournalItemBody) => void
  ): void => this.visitItemsWithLinkage(visit)

  visitItemSteps = (visit: JournalItemLinkageVisitor): Generator<void> =>
    journalInput.visitJournalInputItemSteps(this.state, visit)

  /** One reduced item's body by its journal key, for a writer revising a row it can name. */
  itemBody = (itemId: string): AgentJournalItemBody | null => this.item(itemId)?.body ?? null

  /** Host-only stopped-history IDs carried by each send. */
  stoppedHistoryCarried = (): ReadonlyMap<string, readonly string[]> =>
    this.state.stoppedHistoryCarried

  submissionBody = (clientMessageId: string): AgentJournalMessageItem | null =>
    journalInputSourceBody(this.state.inputs.sources.get(clientMessageId))

  /** One reduced item with its attribution, for a writer that needs the turn a row joined. */
  item = (itemId: string): AgentJournalRenderItem | null =>
    journalInput.readJournalInputItem(this.state, itemId)

  /** Visits reduced items with the producer that wrote each, for a producer re-deriving what an
   *  earlier run of this session left. */
  visitItemsWithLinkage = (visit: JournalItemLinkageVisitor): void =>
    journalInput.visitJournalInputItems(this.state, visit)

  /** Remember publication even after a rewind removes the row. */
  hasRecordedItem = (itemId: string): boolean =>
    this.state.items.has(itemId) || this.state.tombstones.has(itemId)

  /** Read the journal's running turn without allocating a snapshot; host projection decides current work. */
  runningTurn = (): { item: AgentJournalRenderItem; turnId: string } | null =>
    journalPublic.readJournalRunningTurn(this.state)

  newestTurn = (): AgentJournalTurnLifecycle | null =>
    readAgentJournalTurn(journalInputOrder(this.state).newestTurn.read()?.body)

  threadGoalSource = () => journalGoal.journalThreadGoalSource(this.state.items.values())

  threadGoalSourceSteps = () => journalGoal.journalThreadGoalSourceSteps(this.state.items.values())

  /** Read across the journal, beyond any client's loaded page. */
  threadGoal = () => this.threadGoalSource().goal

  /** Read across the journal, beyond any client's loaded page. */
  contextUsage = () => journalUsage.latestStructuredAgentContextFacts(this.state.items.values())

  contextUsageSteps = () =>
    journalUsage.latestStructuredAgentContextFactSteps(this.state.items.values())

  /** Includes activity from revisions/tombstones absent from rendered items. */
  lastActivityAt = (): number => this.state.lastActivityAt

  /** Prefer later execution ownership for reusable children, otherwise creation provenance. */
  itemFence = (itemId: string): number | undefined => journalItemExecutionFence(this.state, itemId)

  /** Preserve both provenance fields during rebuild. */
  itemProvenance = (itemId: string) => journalItemProvenance(this.state, itemId)

  /** Excludes client actions and recovery bookkeeping. */
  lastProviderActivityAt = (fence: number) => this.state.providerActivityAt.get(fence)

  submissions = () => [...this.state.submissions.values()]

  historyOrigin = () => this.state.historyOrigin

  submission = (clientMessageId: string) => this.state.submissions.get(clientMessageId)

  pendingSubmissions = () =>
    this.inputOrder.unsettledSubmissions().filter((entry) => entry.dispatchState === 'pending')

  /** Reconnecting clients read durable acceptance instead of resending. */
  receiptFor = (clientMessageId: string) =>
    journalContext.journalContextReceipt(this.state, clientMessageId)

  physicalCursor = (): AgentJournalCursor => journalContext.physicalJournalCursor(this.state)

  presentationRemoved = (itemId: string): boolean =>
    journalInput.journalInputPresentationRemoved(this.state, itemId)

  canonicalItemId = (itemId: string): string =>
    journalReducer.resolveJournalItemId(this.state, itemId)

  /** Read after all preceding writes and before later ones. */
  readInOrder<T>(read: () => T | Promise<T>): Promise<T> {
    return this.queue.readInOrder(read)
  }

  readSince = (cursor: AgentJournalCursor, limit?: number) => this.history.readSince(cursor, limit)

  readSinceView: JournalHistoryReader['readSinceView']

  /** Assign revisions here so callers cannot publish reducer-stale upserts. */
  appendItem(...args: Parameters<JournalCollaborators['itemAppender']['append']>) {
    return this.itemAppender.append(...args)
  }

  appendClaimingAttachments: typeof this.itemAppender.appendClaimingAttachments = (...args) =>
    this.itemAppender.appendClaimingAttachments(...args)

  /** Resolve on the write lane; null appends nothing. */
  appendResolvedItem: typeof this.itemAppender.appendResolved = (resolve, options) =>
    this.itemAppender.appendResolved(resolve, options)

  appendTombstone(...args: Parameters<JournalCollaborators['itemAppender']['tombstone']>) {
    return this.itemAppender.tombstone(...args)
  }

  withdrawGoalObjective(
    identity: AgentJournalItemIdentity,
    options: JournalTombstoneInput
  ): Promise<AgentJournalCursor> {
    return this.appendTombstone(
      identity,
      options,
      this.goalAttachments.withdraw(agentJournalItemKey(identity))
    )
  }

  keepGoalAttachments = (identity: AgentJournalItemIdentity): Promise<void> =>
    this.queue.serialize(() => this.goalAttachments.keep(agentJournalItemKey(identity)))

  appendStopEvent(event: Omit<JournalStopEvent, 'at'>, fence: number): Promise<AgentJournalCursor> {
    return this.rowWriter.append(
      stopRows.journalStopEventRowBuilder(() => this.state, event, fence, this.now())
    )
  }

  appendQueueResume(fence: number, receipt?: JournalOperationReceipt): Promise<AgentJournalCursor> {
    return this.rowWriter.append(
      stopRows.journalQueueResumeRowBuilder(() => this.state, fence),
      receipt
    )
  }

  appendQueueReopen(fence: number, since?: number): Promise<AgentJournalCursor> {
    return this.rowWriter.append(
      stopRows.journalQueueReopenRowBuilder(() => this.state, fence, since)
    )
  }

  /** Mark preexisting cards; failed writes retain a conservative reopenFloor and throw. */
  async markQueueReopen(fence: number, since?: number): Promise<void> {
    if (this.queuedMessages.awaitReopenMark()) {
      const sequence = since ?? this.state.lastSequence + 1
      this.reopenUnmarked = { epoch: this.state.epoch, sequence }
      await this.appendQueueReopen(fence, since)
    }
  }

  appendLifecycleBatch = (input: JournalLifecycleBatchInput): Promise<AgentJournalCursor> =>
    this.lifecycleBatchAppender.append(input)

  appendPlannedLifecycleBatch = (input: JournalPlannedLifecycleBatchInput) =>
    this.lifecycleBatchAppender.appendPlanned(input)

  appendSteps: typeof this.stepWriter.append = (steps) => this.stepWriter.append(steps)

  appendSubmission(...args: Parameters<JournalCollaborators['submissionWriter']['append']>) {
    return this.submissionWriter.append(...args)
  }

  resolveDispatch(
    ...args: Parameters<JournalCollaborators['submissionWriter']['resolveDispatch']>
  ) {
    return this.submissionWriter.resolveDispatch(...args)
  }

  acceptLate: typeof this.submissionWriter.acceptLate = (i) => this.submissionWriter.acceptLate(i)

  /** Retire unanswered sends after their execution owner ended, without assuming delivery. */
  markPendingSubmissionsUnknown = (fence: number, reason?: string): Promise<string[]> =>
    pendingRecovery.markJournalPendingSubmissionsUnknown(this, fence, reason)

  /** Failed initialization proves handed-over but unanswered sends never ran. */
  rejectPendingSubmissions = (fence: number, rejection: AgentJournalDispatchRejection) =>
    pendingRecovery.rejectJournalPendingSubmissions(this, fence, rejection)

  rejectQueuedSubmissions = (
    fence: number,
    rejection: AgentJournalDispatchRejection,
    which?: (submission: AgentJournalSubmission) => boolean
  ): Promise<string[]> =>
    pendingRecovery.rejectJournalQueuedSubmissions(this, fence, rejection, which)

  /** Epoch rollover invalidates every client cursor. */
  rollEpoch = (reason: AgentJournalEpochReason, fence: number): Promise<AgentJournalCursor> =>
    this.epochController.roll(reason, fence)

  replaceEpochItems(...args: Parameters<JournalCollaborators['epochController']['replace']>) {
    return this.epochController.replace(...args)
  }
}
