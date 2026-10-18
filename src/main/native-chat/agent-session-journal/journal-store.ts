// Append-only journal store for one agent session. It owns the chat's fold and write queue, and no
// connection: every statement goes through the host's one journal database.

import { QueuedMessageReopenFloor } from './queued-message-reopen-floor'
import type { AgentJournalDispatchRejection } from '../../../shared/agent-session-failure-words'
import { randomUUID } from 'node:crypto'
import type {
  AgentJournalAcceptanceReceipt,
  AgentJournalCursor,
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalRenderItem,
  AgentJournalSnapshot,
  AgentJournalSubmission,
  AgentJournalThreadGoal,
  AgentJournalTurnLifecycle,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentSessionContextUsage } from '../../../shared/agent-session-context-usage'
import { latestStructuredAgentContextFacts } from '../../../shared/structured-agent-session-context-usage'
import {
  newestStructuredAgentSessionTurnBySequence,
  runningStructuredAgentSessionTurnItemBySequence
} from '../../../shared/structured-agent-session-live-turn'
import type { JournalReplacementItem } from './journal-epoch-replacement'
import { readJournalSince } from './journal-cursor'
import type { JournalHostDatabase, JournalWriteOptions } from './journal-host-database'
import { journalRowsAfterReader, type JournalLoad } from './journal-open'
import * as pendingRecovery from './journal-pending-submission-recovery'
import {
  applyJournalRow,
  createJournalReducerState,
  renderJournalState,
  resolveJournalItemId,
  type JournalReducerState
} from './journal-reducer'
import { journalTombstoneRowBuilder } from './journal-row-builders'
import type {
  AgentSessionJournalOptions,
  JournalAppendResult,
  JournalItemAppendOptions,
  JournalItemLinkageVisitor,
  JournalLifecycleBatchInput,
  JournalPlannedLifecycleBatchInput,
  JournalReadSince,
  JournalSubmissionConsume,
  JournalSubmissionInput,
  JournalTombstoneInput,
  ResolveDispatchInput
} from './journal-store-contracts'
import type { JournalQueuedMessages } from './journal-queued-messages'
import {
  journalQueueResumeRowBuilder,
  journalQueueReopenRowBuilder,
  journalStopEventRowBuilder
} from './journal-stop-and-resume-rows'
import type { AgentJournalEpochReason, JournalRow, JournalStopEvent } from './journal-row-schema'
import type * as RowWriter from './journal-row-writer'
import type { JournalSubmissionWriter } from './journal-submission-writer'
import type { JournalEpochController } from './journal-epoch-controller'
import { JournalWriteQueue } from './journal-write-queue'
import { journalItemExecutionFence, journalItemProvenance } from './journal-item-provenance'
import { createJournalStoreCollaborators } from './journal-store-collaborators'
import type { JournalItemAppender } from './journal-item-appender'
import type { JournalLifecycleBatchAppender } from './journal-lifecycle-batch-appender'
import type { JournalStepWriter } from './journal-step-writer'
import type { JournalStopMarks } from './journal-stop-marks'
import type { JournalContextController } from './journal-context-controller'
import type { JournalStopAcceptor } from './journal-stop-acceptance'
import { journalThreadGoalSource, type JournalThreadGoalSource } from './journal-thread-goal-source'

export { AgentSessionJournalError } from './journal-write-guards'

export class AgentSessionJournal {
  private readonly identity: AgentSessionJournalIdentity
  private readonly database: JournalHostDatabase
  private readonly now: () => number
  private readonly mintEpoch: () => string

  private state: JournalReducerState
  private openedThrough: AgentJournalCursor = { epoch: '', sequence: 0 }
  private readExecutionObservation?: () => number | null
  private readonly reopen: QueuedMessageReopenFloor
  private onCommitted: ((rows?: readonly JournalRow[]) => void) | null = null
  private readonly queue: JournalWriteQueue
  private readonly rowWriter: RowWriter.JournalRowWriter
  private readonly epochController: JournalEpochController
  private readonly itemAppender: JournalItemAppender
  private readonly lifecycleBatchAppender: JournalLifecycleBatchAppender
  private readonly submissionWriter: JournalSubmissionWriter
  private readonly stepWriter: JournalStepWriter
  private readonly restore: () => Promise<void>
  /** Draft rows queued while the agent works; never reducer input or owed work. */
  readonly queuedMessages: JournalQueuedMessages
  readonly stopMarks: JournalStopMarks
  /** A person's Stop accepted (`journal-stop-acceptance.ts`). */
  readonly stops: JournalStopAcceptor
  readonly context: JournalContextController

  constructor(options: AgentSessionJournalOptions) {
    this.identity = options.identity
    this.database = options.database
    this.now = options.now ?? (() => Date.now())
    this.mintEpoch = options.mintEpoch ?? randomUUID
    this.state = createJournalReducerState(options.identity.sessionId, '')
    // Serializes sequence assignment with the durable write behind it.
    this.queue = new JournalWriteQueue(options.identity.sessionId)
    const collaborators = createJournalStoreCollaborators({
      identity: this.identity,
      now: this.now,
      mintEpoch: this.mintEpoch,
      serialize: (run) => this.queue.serialize(run),
      database: () => this.database,
      state: () => this.state,
      // A newer Orca's database: nothing it holds opens, and every write is refused.
      readOnly: () => this.database.readOnly,
      cursor: this.cursor,
      adopt: (loaded) => {
        this.adoptLoadedJournal(loaded)
        this.onCommitted?.()
      },
      commit: (rows, savedAt) => {
        for (const row of rows) {
          applyJournalRow(this.state, row, savedAt)
        }
        this.onCommitted?.(rows)
      },
      notifyCommitted: () => this.onCommitted?.(),
      journal: () => this,
      enqueue: (build, receipt) => this.rowWriter.enqueue(build, undefined, receipt)
    })
    this.rowWriter = collaborators.rowWriter
    this.epochController = collaborators.epochController
    this.itemAppender = collaborators.itemAppender
    this.lifecycleBatchAppender = collaborators.lifecycleBatchAppender
    this.submissionWriter = collaborators.submissionWriter
    this.stepWriter = collaborators.stepWriter
    this.queuedMessages = collaborators.queuedMessages
    this.reopen = new QueuedMessageReopenFloor(this.queuedMessages)
    this.stopMarks = collaborators.stopMarks
    this.stops = collaborators.stops
    this.restore = collaborators.restore
    this.context = collaborators.context
  }

  get epoch(): string {
    return this.state.epoch
  }

  get agent(): AgentSessionJournalIdentity['agent'] {
    return this.identity.agent
  }

  /** Whether a row at this sequence was on disk when this handle opened, so an earlier handle
   *  wrote it. Sequences restart with each epoch, so a row of a later epoch never was. */
  wroteBeforeOpen(sequence: number | undefined): boolean {
    return (
      sequence !== undefined &&
      this.state.epoch === this.openedThrough.epoch &&
      sequence <= this.openedThrough.sequence
    )
  }

  /** Where this handle opened the journal (`wroteBeforeOpen`). */
  openedAt = (): AgentJournalCursor => this.openedThrough

  observeExecutionWith(read: () => number | null): void {
    this.readExecutionObservation = read
  }

  observedExecution = (): number | null | undefined => this.readExecutionObservation?.()

  /** Where the reopen's pause begins while no mark holds it: where this handle's mark would go.
   *  Null once a mark is written. Per handle, so the next open derives it again. */
  reopenFloor = (): AgentJournalCursor | null => this.reopen.get()

  async open(): Promise<void> {
    await this.restore()
    this.openedThrough = this.cursor()
  }

  /** A conversation's open, which always follows the chat stopping (a quit, a crash or a close):
   *  a card it finds waits for a turn from where this handle opened, derived with nothing written,
   *  unless an earlier mark already holds it. The mark that follows records the same start. */
  holdReopenFromOpen = (): void => this.reopen.holdFromOpen(this.openedThrough)

  /** Refuses every later write and resolves once the admitted ones have landed. Holds no
   *  connection, so there is nothing to release and nothing that can fail. */
  close(): Promise<void> {
    this.queuedMessages.editLeases.dispose()
    this.queue.markClosed()
    return this.queue.drain()
  }

  /** Told of every durable change, epoch replacements included, so a reader learns of a write
   *  without its writer saying so. One listener: a later call replaces it. It must not throw. */
  observeCommits(listener: (rows?: readonly JournalRow[]) => void): void {
    this.onCommitted = listener
  }

  cursor = (): AgentJournalCursor => ({
    epoch: this.state.epoch,
    sequence: this.state.lastSequence
  })

  snapshot = (): AgentJournalSnapshot => renderJournalState(this.state)

  /** Visits reduced items without allocating and sorting a full snapshot. */
  visitItems = (
    visit: (itemId: string, sequence: number, body: AgentJournalItemBody) => void
  ): void => {
    for (const item of this.state.items.values()) {
      visit(item.itemId, item.sequence, item.body)
    }
  }

  /** One reduced item's body by its journal key, for a writer revising a row it can name. */
  itemBody = (itemId: string): AgentJournalItemBody | null =>
    this.state.items.get(itemId)?.body ?? null

  /** Host-only: the stopped messages each handed-over send carried, by its client message id. */
  stoppedHistoryCarried = (): ReadonlyMap<string, readonly string[]> =>
    this.state.stoppedHistoryCarried

  /** One reduced item with its attribution, for a writer that needs the turn a row joined. */
  item = (itemId: string): AgentJournalRenderItem | null => this.state.items.get(itemId) ?? null

  /** Visits reduced items with the producer that wrote each, for a producer re-deriving what an
   *  earlier run of this session left. */
  visitItemsWithLinkage = (visit: JournalItemLinkageVisitor): void => {
    for (const item of this.state.items.values()) {
      visit(item.itemId, item.sequence, item.body, item)
    }
  }

  /** The turn this journal records as running, with its record's item, whichever generation
   *  opened it — the same read a client's snapshot gives, without materialising one. Whether it is
   *  current work is the host projection's to say (`structuredAgentSessionCurrentWork`). */
  runningTurn = (): { item: AgentJournalRenderItem; turnId: string } | null =>
    runningStructuredAgentSessionTurnItemBySequence(this.state.items.values())

  /** The newest turn record whatever state it settled in, for readers that need the outcome. */
  newestTurn = (): AgentJournalTurnLifecycle | null =>
    newestStructuredAgentSessionTurnBySequence(this.state.items.values())

  /** The latest goal and its row, for a provider revising accounting after restart. */
  threadGoalSource = (): JournalThreadGoalSource =>
    journalThreadGoalSource(this.state.items.values())

  /** The latest goal the whole journal records, not only a client's loaded page. */
  threadGoal = (): AgentJournalThreadGoal | null => this.threadGoalSource().goal

  /** The newest context facts the whole journal records, not only a client's loaded page. */
  contextUsage = (): AgentSessionContextUsage =>
    latestStructuredAgentContextFacts(this.state.items.values())

  /** Includes revisions and completion tombstones, whose timestamps disappear from render items. */
  lastActivityAt = (): number => this.state.lastActivityAt

  /** Whose execution the item is now, while it is in the timeline: the run a reusable child's row
   *  last named (`JournalItemRow.executionOwner`), else its creator (`JournalItemRow.ownerFence`). */
  itemFence = (itemId: string): number | undefined => journalItemExecutionFence(this.state, itemId)

  /** Both provenance facts as stored, for a rebuild that writes them again. */
  itemProvenance = (itemId: string) => journalItemProvenance(this.state, itemId)

  /** Latest saved output at this fence, excluding client actions and recovery bookkeeping. */
  lastProviderActivityAt = (fence: number) => this.state.providerActivityAt.get(fence)

  submissions = (): AgentJournalSubmission[] => [...this.state.submissions.values()]

  submission = (clientMessageId: string) => this.state.submissions.get(clientMessageId)

  pendingSubmissions = (): AgentJournalSubmission[] =>
    this.submissions().filter((entry) => entry.dispatchState === 'pending')

  /** The durable answer to "did my send land?" — a reconnecting client asking
   *  again gets this instead of re-sending. */
  receiptFor = (clientMessageId: string): AgentJournalAcceptanceReceipt | null =>
    this.state.receipts.get(clientMessageId) ?? null

  canonicalItemId = (itemId: string): string => resolveJournalItemId(this.state, itemId)

  /** Reads the fold with every write issued before this call committed, and none issued after: at
   *  once unless a write is running or writes wait in line. */
  readInOrder<T>(read: () => T): Promise<T> {
    return this.queue.readInOrder(read)
  }

  readSince(cursor: AgentJournalCursor, limit?: number): JournalReadSince {
    const { sessionId } = this.identity
    const rowsAfter = journalRowsAfterReader(this.database.db, sessionId, this.state.epoch, limit)
    return readJournalSince({ state: this.state, rowsAfter }, cursor, () => this.cursor())
  }

  /** Upsert by stable identity. The revision is assigned here so a caller
   *  cannot accidentally publish a revision the reducer will drop. */
  appendItem(
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    options: JournalItemAppendOptions,
    receipt?: RowWriter.JournalOperationReceipt
  ): Promise<JournalAppendResult> {
    return this.itemAppender.append(identity, body, options, receipt)
  }

  /** An upsert whose row is chosen from the fold at its own turn in the queue; null writes nothing. */
  appendResolvedItem: JournalItemAppender['appendResolved'] = (resolve, options) =>
    this.itemAppender.appendResolved(resolve, options)

  appendTombstone(
    identity: AgentJournalItemIdentity,
    { fence }: JournalTombstoneInput
  ): Promise<AgentJournalCursor> {
    const itemId = agentJournalItemKey(identity)
    return this.rowWriter.append(journalTombstoneRowBuilder(() => this.state, itemId, fence))
  }

  /** A Stop that took effect, timed by its row (`JournalStopEvent`). */
  appendStopEvent(event: Omit<JournalStopEvent, 'at'>, fence: number): Promise<AgentJournalCursor> {
    return this.rowWriter.append(journalStopEventRowBuilder(() => this.state, event, fence))
  }

  /** A person's Resume of the queue. */
  appendQueueResume(
    fence: number,
    receipt?: RowWriter.JournalOperationReceipt
  ): Promise<AgentJournalCursor> {
    const build = journalQueueResumeRowBuilder(() => this.state, fence)
    return this.rowWriter.append(build, undefined, receipt)
  }

  /** This open found waiting cards an earlier handle wrote (`queued-message-pause.ts`). */
  appendQueueReopen(fence: number, since?: number, options?: JournalWriteOptions) {
    const build = journalQueueReopenRowBuilder(() => this.state, fence, since)
    return this.rowWriter.append(build, undefined, undefined, options)
  }

  /** Marks the reopen (`QueuedMessageReopenFloor.mark`), from `since` when the chat stopped before
   *  now; a failed write leaves the pause's start where the mark would have gone, and throws. */
  markQueueReopen(fence: number, since?: number, options?: JournalWriteOptions): Promise<void> {
    const at = { epoch: this.state.epoch, sequence: since ?? this.state.lastSequence + 1 }
    return this.reopen.mark(at, () => this.appendQueueReopen(fence, since, options))
  }

  appendLifecycleBatch(input: JournalLifecycleBatchInput): Promise<AgentJournalCursor> {
    return this.lifecycleBatchAppender.append(input)
  }

  /** A lifecycle batch planned at its own turn in the queue (`JournalPlannedLifecycleBatchInput`). */
  appendPlannedLifecycleBatch = (input: JournalPlannedLifecycleBatchInput) =>
    this.lifecycleBatchAppender.appendPlanned(input)

  /** Several writes as one turn in the queue; see `JournalStepWriter`. */
  appendSteps: JournalStepWriter['append'] = (steps) => this.stepWriter.append(steps)

  /** The write-ahead submission row (`JournalSubmissionWriter.append`). */
  appendSubmission(
    input: JournalSubmissionInput,
    consume?: JournalSubmissionConsume,
    receipt?: RowWriter.JournalOperationReceipt
  ): Promise<AgentJournalCursor> {
    return this.submissionWriter.append(input, consume, receipt)
  }

  /** A dispatch transition (`JournalSubmissionWriter.resolveDispatch`). */
  resolveDispatch(
    input: ResolveDispatchInput,
    hook?: RowWriter.JournalRowTransactionHook
  ): Promise<AgentJournalCursor> {
    return this.submissionWriter.resolveDispatch(input, hook)
  }

  /** Retire unanswered sends after their execution owner ended, without assuming delivery. */
  async markPendingSubmissionsUnknown(fence: number, reason?: string): Promise<string[]> {
    return pendingRecovery.markJournalPendingSubmissionsUnknown(this, fence, reason)
  }

  /** Reject sends a child that ended in its start was handed and never echoed: none ran. */
  async rejectPendingSubmissions(
    fence: number,
    rejection: AgentJournalDispatchRejection
  ): Promise<string[]> {
    return pendingRecovery.rejectJournalPendingSubmissions(this, fence, rejection)
  }

  /** Reject sends accepted but never handed over, optionally only those `which` names. */
  rejectQueuedSubmissions = (
    fence: number,
    rejection: AgentJournalDispatchRejection,
    which?: (submission: AgentJournalSubmission) => boolean
  ): Promise<string[]> =>
    pendingRecovery.rejectJournalQueuedSubmissions(this, fence, rejection, which)

  /** The escape hatch for a forked handle and an unreadable schema. It invalidates every cursor;
   *  clients reload. */
  async rollEpoch(reason: AgentJournalEpochReason, fence: number): Promise<AgentJournalCursor> {
    return this.epochController.roll(reason, fence)
  }

  replaceEpochItems(
    reason: AgentJournalEpochReason,
    fence: number,
    items: readonly JournalReplacementItem[],
    options?: JournalWriteOptions
  ): Promise<AgentJournalCursor> {
    return this.epochController.replace(reason, fence, items, options)
  }

  private adoptLoadedJournal(loaded: JournalLoad): void {
    this.state = loaded.state
  }
}
