import { JournalMailDisplayReports } from './journal-mail-display-reports'
import { journalInputSourceBody } from './journal-input-source'
import { journalInputOrder } from './journal-input-order'
import { JournalWriteProjection } from './journal-write-projection'
import type { AgentJournalDispatchRejection } from '../../../shared/agent-session/failures/agent-session-failure-words'
import { randomUUID } from 'node:crypto'
import { retireCoveredJournalFloor } from './journal-commit'
import { createJournalPublicReader, renderJournalStatus } from './journal-public-read'
import type * as Journal from '../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  AgentJournalItemIdentity,
  AgentJournalCursor,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentSessionContextUsage } from '../../../shared/agent-session/agent-session-context-usage'
import { latestStructuredAgentContextFacts } from '../../../shared/agent-session/structured-agent-session-context-usage'
import { runningStructuredAgentSessionTurnItemBySequence } from '../../../shared/agent-session/view/structured-agent-session-live-turn'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { journalWroteBeforeOpen } from './journal-cursor'
import type { JournalHostDatabase } from './journal-host-database'
import {
  markJournalPendingSubmissionsUnknown,
  rejectJournalPendingSubmissions,
  rejectJournalQueuedSubmissions
} from './journal-pending-submission-recovery'
import {
  createJournalReducerState,
  resolveJournalItemId,
  type JournalReducerState
} from './journal-reducer'
import { journalTombstoneRowBuilder } from './journal-row-builders'
import type * as Store from './journal-store-contracts'
import {
  journalQueueResumeRowBuilder,
  journalQueueReopenRowBuilder,
  journalStopEventRowBuilder
} from './journal-stop-and-resume-rows'
import type { AgentJournalEpochReason, JournalStopEvent, JournalRow } from './journal-row-schema'
import type { JournalOperationReceipt } from './journal-row-writer'
import { JournalWriteQueue } from './journal-write-queue'
import { journalItemExecutionFence, journalItemProvenance } from './journal-item-provenance'
import { createJournalStoreCollaborators } from './journal-store-collaborators'
import { journalThreadGoalSource, type JournalThreadGoalSource } from './journal-thread-goal-source'
// Each session owns its fold and queue; all statements use the host's shared database connection.

import * as journalInput from './journal-input-obligations'
import * as journalContext from './journal-context-cursor'

type JournalCollaborators = ReturnType<typeof createJournalStoreCollaborators>

export class AgentSessionJournal {
  readonly mailDisplayReports: JournalMailDisplayReports
  private readonly goalAttachments: JournalCollaborators['goalAttachments']
  private readonly identity: AgentSessionJournalIdentity
  private readonly database: JournalHostDatabase

  private state: JournalReducerState
  private readonly readPublic = createJournalPublicReader(() => this.inputOrder)
  private openedThrough: AgentJournalCursor = { epoch: '', sequence: 0 }
  private reopenUnmarked: AgentJournalCursor | null = null
  private onCommitted: Parameters<AgentSessionJournal['observeCommits']>[0] | null = null
  private readonly queue: JournalWriteQueue
  private readonly rowWriter: JournalCollaborators['rowWriter']
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

  constructor(options: Store.AgentSessionJournalOptions) {
    this.mailDisplayReports = new JournalMailDisplayReports(options.identity.sessionId)
    this.identity = options.identity
    this.database = options.database
    this.state = createJournalReducerState(options.identity.sessionId, '')
    this.queue = new JournalWriteQueue(options.identity.sessionId)
    this.projection = new JournalWriteProjection({
      ...options,
      mailDisplayReports: this.mailDisplayReports,
      state: () => this.state,
      adopt: (state) => {
        this.state = state
        this.reopenUnmarked = retireCoveredJournalFloor(state, this.reopenUnmarked)
      }
    })
    const collaborators = createJournalStoreCollaborators({
      identity: this.identity,
      now: options.now ?? (() => Date.now()),
      mintEpoch: options.mintEpoch ?? randomUUID,
      serialize: (run) => this.queue.serialize(run),
      database: () => this.database,
      state: () => this.state,
      readOnly: () => this.database.readOnly,
      cursor: this.cursor,
      adopt: (loaded) => {
        journalInputOrder(loaded.state).carryRecovery(journalInputOrder(this.state))
        this.state = loaded.state
        this.mailDisplayReports.load(this.database.db)
        this.mailDisplayReports.rebuildOwners(this.state, this.queuedMessages.list())
        this.onCommitted?.()
      },
      prepare: (db, rows, savedAt, finishFold) => {
        this.queuedMessages.inputState()
        return this.projection.prepare(db, rows, savedAt, finishFold)
      },
      commit: (rows, _savedAt, inputChanged) => {
        this.onCommitted?.(rows, inputChanged)
        this.projection.verify()
      },
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

  /** Rows from a previous handle retain physical provenance through logical boundaries. */
  wroteBeforeOpen(sequence: number | undefined): boolean {
    return journalWroteBeforeOpen(this.state, this.openedThrough, sequence)
  }

  /** Fallback reopen boundary until its mark is written; each new handle marks again. */
  reopenFloor(): AgentJournalCursor | null {
    return this.reopenUnmarked
  }

  async open(): Promise<void> {
    await this.restore()
    this.database.transaction(
      (db) => this.mailDisplayReports.retire(db),
      false,
      (retired) => retired()
    )
    this.openedThrough = { epoch: this.state.epoch, sequence: this.state.lastSequence }
    journalInputOrder(this.state).markOpeningRecovery()
  }

  /** Refuse future writes and drain admitted ones; the host retains database ownership. */
  close(): Promise<void> {
    this.queuedMessages.editLeases.dispose()
    this.queue.markClosed()
    return this.queue.drain().finally(() => this.mailDisplayReports.close())
  }

  /** One nonthrowing listener; undefined rows mean adopted history, an empty array means metadata. */
  observeCommits(
    listener: (rows?: readonly JournalRow[], inputChanged?: boolean) => void
  ): () => void {
    const registered: typeof listener = (...args) => listener(...args)
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

  statusRead = () => renderJournalStatus(this.queuedMessages.displayState(), this.inputOrder)

  publicRead = () =>
    this.readPublic(this.state, this.queuedMessages.displayState(), this.queuedMessages.revision())

  /** Visit without allocating/sorting a snapshot. */
  visitItems = (
    visit: (itemId: string, sequence: number, body: Journal.AgentJournalItemBody) => void
  ): void => this.visitItemsWithLinkage(visit)

  /** One reduced item's body by its journal key, for a writer revising a row it can name. */
  itemBody = (itemId: string): Journal.AgentJournalItemBody | null =>
    this.item(itemId)?.body ?? null

  /** Host-only stopped-history IDs carried by each send. */
  stoppedHistoryCarried = (): ReadonlyMap<string, readonly string[]> =>
    this.state.stoppedHistoryCarried

  submissionBody = (clientMessageId: string): Journal.AgentJournalMessageItem | null =>
    journalInputSourceBody(this.state.inputs.sources.get(clientMessageId))

  /** One reduced item with its attribution, for a writer that needs the turn a row joined. */
  item = (itemId: string): Journal.AgentJournalRenderItem | null =>
    journalInput.readJournalInputItem(this.state, itemId)

  /** Visits reduced items with the producer that wrote each, for a producer re-deriving what an
   *  earlier run of this session left. */
  visitItemsWithLinkage = (visit: Store.JournalItemLinkageVisitor): void =>
    journalInput.visitJournalInputItems(this.state, visit)

  /** Remember publication even after a rewind removes the row. */
  hasRecordedItem = (itemId: string): boolean =>
    this.state.items.has(itemId) || this.state.tombstones.has(itemId)

  /** Read the journal's running turn without allocating a snapshot; host projection decides current work. */
  runningTurn = (): { item: Journal.AgentJournalRenderItem; turnId: string } | null =>
    runningStructuredAgentSessionTurnItemBySequence(this.state.items.values())

  newestTurn = (): Journal.AgentJournalTurnLifecycle | null =>
    readAgentJournalTurn(journalInputOrder(this.state).newestTurn.read()?.body)

  threadGoalSource = (): JournalThreadGoalSource =>
    journalThreadGoalSource(this.state.items.values())

  /** Read across the journal, beyond any client's loaded page. */
  threadGoal = () => this.threadGoalSource().goal

  /** Read across the journal, beyond any client's loaded page. */
  contextUsage = (): AgentSessionContextUsage =>
    latestStructuredAgentContextFacts(this.state.items.values())

  /** Includes activity from revisions/tombstones absent from rendered items. */
  lastActivityAt = (): number => this.state.lastActivityAt

  /** Prefer later execution ownership for reusable children, otherwise creation provenance. */
  itemFence = (itemId: string): number | undefined => journalItemExecutionFence(this.state, itemId)

  /** Preserve both provenance fields during rebuild. */
  itemProvenance = (itemId: string) => journalItemProvenance(this.state, itemId)

  /** Excludes client actions and recovery bookkeeping. */
  lastProviderActivityAt = (fence: number) => this.state.providerActivityAt.get(fence)

  submissions = (): Journal.AgentJournalSubmission[] => [...this.state.submissions.values()]

  historyOrigin = () => this.state.historyOrigin

  submission = (clientMessageId: string) => this.state.submissions.get(clientMessageId)

  pendingSubmissions = () =>
    this.inputOrder.unsettledSubmissions().filter((entry) => entry.dispatchState === 'pending')

  /** Reconnecting clients read durable acceptance instead of resending. */
  receiptFor = (clientMessageId: string): Journal.AgentJournalAcceptanceReceipt | null =>
    journalContext.journalContextReceipt(this.state, clientMessageId)

  physicalCursor = (): AgentJournalCursor => journalContext.physicalJournalCursor(this.state)

  presentationRemoved = (itemId: string): boolean =>
    journalInput.journalInputPresentationRemoved(this.state, itemId)

  canonicalItemId = (itemId: string): string => resolveJournalItemId(this.state, itemId)

  /** Read after all preceding writes and before later ones. */
  readInOrder<T>(read: () => T): Promise<T> {
    return this.queue.readInOrder(read)
  }

  readSince(cursor: AgentJournalCursor, limit?: number) {
    const { database, state } = this
    return journalContext.readStoredJournalContextSince(database.db, state, cursor, limit)
  }

  /** Assign revisions here so callers cannot publish reducer-stale upserts. */
  appendItem(...args: Parameters<typeof this.itemAppender.append>) {
    return this.itemAppender.append(...args)
  }

  appendClaimingAttachments: typeof this.itemAppender.appendClaimingAttachments = (...args) =>
    this.itemAppender.appendClaimingAttachments(...args)

  /** Resolve on the write lane; null appends nothing. */
  appendResolvedItem: typeof this.itemAppender.appendResolved = (resolve, options) =>
    this.itemAppender.appendResolved(resolve, options)

  appendTombstone(
    identity: AgentJournalItemIdentity,
    { fence }: Store.JournalTombstoneInput,
    receipt?: JournalOperationReceipt
  ): Promise<AgentJournalCursor> {
    const itemId = agentJournalItemKey(identity)
    return this.rowWriter.append(
      journalTombstoneRowBuilder(() => this.state, itemId, fence),
      receipt
    )
  }

  withdrawGoalObjective(
    identity: AgentJournalItemIdentity,
    options: Store.JournalTombstoneInput
  ): Promise<AgentJournalCursor> {
    return this.appendTombstone(
      identity,
      options,
      this.goalAttachments.withdraw(agentJournalItemKey(identity))
    )
  }

  keepGoalAttachments(identity: AgentJournalItemIdentity): Promise<void> {
    return this.queue.serialize(() => this.goalAttachments.keep(agentJournalItemKey(identity)))
  }

  appendStopEvent(event: Omit<JournalStopEvent, 'at'>, fence: number): Promise<AgentJournalCursor> {
    return this.rowWriter.append(journalStopEventRowBuilder(() => this.state, event, fence))
  }

  appendQueueResume(fence: number, receipt?: JournalOperationReceipt): Promise<AgentJournalCursor> {
    const build = journalQueueResumeRowBuilder(() => this.state, fence)
    return this.rowWriter.append(build, receipt)
  }

  appendQueueReopen(fence: number, since?: number): Promise<AgentJournalCursor> {
    return this.rowWriter.append(journalQueueReopenRowBuilder(() => this.state, fence, since))
  }

  /** Mark preexisting cards; failed writes retain a conservative reopenFloor and throw. */
  async markQueueReopen(fence: number, since?: number): Promise<void> {
    if (this.queuedMessages.awaitReopenMark()) {
      const sequence = since ?? this.state.lastSequence + 1
      this.reopenUnmarked = { epoch: this.state.epoch, sequence }
      await this.appendQueueReopen(fence, since)
    }
  }

  appendLifecycleBatch(input: Store.JournalLifecycleBatchInput): Promise<AgentJournalCursor> {
    return this.lifecycleBatchAppender.append(input)
  }

  appendPlannedLifecycleBatch = (input: Store.JournalPlannedLifecycleBatchInput) =>
    this.lifecycleBatchAppender.appendPlanned(input)

  appendSteps: typeof this.stepWriter.append = (steps) => this.stepWriter.append(steps)

  appendSubmission(...args: Parameters<typeof this.submissionWriter.append>) {
    return this.submissionWriter.append(...args)
  }

  resolveDispatch(...args: Parameters<typeof this.submissionWriter.resolveDispatch>) {
    return this.submissionWriter.resolveDispatch(...args)
  }

  acceptLate: typeof this.submissionWriter.acceptLate = (i) => this.submissionWriter.acceptLate(i)

  /** Retire unanswered sends after their execution owner ended, without assuming delivery. */
  async markPendingSubmissionsUnknown(fence: number, reason?: string): Promise<string[]> {
    return markJournalPendingSubmissionsUnknown(this, fence, reason)
  }

  /** Failed initialization proves handed-over but unanswered sends never ran. */
  async rejectPendingSubmissions(fence: number, rejection: AgentJournalDispatchRejection) {
    return rejectJournalPendingSubmissions(this, fence, rejection)
  }

  rejectQueuedSubmissions = (
    fence: number,
    rejection: AgentJournalDispatchRejection,
    which?: (submission: Journal.AgentJournalSubmission) => boolean
  ): Promise<string[]> => rejectJournalQueuedSubmissions(this, fence, rejection, which)

  /** Reset provider presentation and invalidate public cursors, retaining canonical input. */
  async rollEpoch(reason: AgentJournalEpochReason, fence: number): Promise<AgentJournalCursor> {
    return this.epochController.roll(reason, fence)
  }

  replaceEpochItems(...args: Parameters<typeof this.epochController.replace>) {
    return this.epochController.replace(...args)
  }
}
