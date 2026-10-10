// Append-only journal store for one agent session. It owns the chat's fold and write queue, and no
// connection: every statement goes through the host's one journal database.

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
  AgentJournalTurnScope,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { currentAgentSessionThreadGoalBySequence } from '../../../shared/agent-session-thread-goal'
import type { AgentSessionContextUsage } from '../../../shared/agent-session-context-usage'
import { latestStructuredAgentContextFacts } from '../../../shared/structured-agent-session-context-usage'
import {
  activeStructuredAgentSessionTurnIdBySequence,
  liveStructuredAgentSessionTurnScope,
  newestStructuredAgentSessionTurnBySequence
} from '../../../shared/structured-agent-session-live-turn'
import type { JournalReplacementItem } from './journal-epoch-replacement'
import { readJournalSince } from './journal-cursor'
import type { JournalHostDatabase } from './journal-host-database'
import { journalRowsAfterReader, type JournalLoad } from './journal-open'
import {
  markJournalPendingSubmissionsUnknown,
  rejectJournalPendingSubmissions,
  rejectJournalQueuedSubmissions
} from './journal-pending-submission-recovery'
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
import type { AgentJournalEpochReason, JournalStopEvent } from './journal-row-schema'
import type {
  JournalOperationReceipt,
  JournalRowTransactionHook,
  JournalRowWriter
} from './journal-row-writer'
import type { JournalSubmissionWriter } from './journal-submission-writer'
import type { JournalEpochController } from './journal-epoch-controller'
import { JournalWriteQueue } from './journal-write-queue'
import { createJournalStoreCollaborators } from './journal-store-collaborators'
import type { JournalItemAppender } from './journal-item-appender'
import type { JournalLifecycleBatchAppender } from './journal-lifecycle-batch-appender'
import type { JournalStepWriter } from './journal-step-writer'
import type { JournalStopMarks } from './journal-stop-marks'
import { JournalContextController } from './journal-context-controller'

export { AgentSessionJournalError } from './journal-write-guards'

export class AgentSessionJournal {
  private readonly identity: AgentSessionJournalIdentity
  private readonly database: JournalHostDatabase
  private readonly now: () => number
  private readonly mintEpoch: () => string

  private state: JournalReducerState
  private openedThrough: AgentJournalCursor = { epoch: '', sequence: 0 }
  private reopenUnmarked: AgentJournalCursor | null = null
  private onCommitted: (() => void) | null = null
  private readonly queue: JournalWriteQueue
  private readonly rowWriter: JournalRowWriter
  private readonly epochController: JournalEpochController
  private readonly itemAppender: JournalItemAppender
  private readonly lifecycleBatchAppender: JournalLifecycleBatchAppender
  private readonly submissionWriter: JournalSubmissionWriter
  private readonly stepWriter: JournalStepWriter
  private readonly restore: () => Promise<void>
  /** Draft rows queued while the agent works; never reducer input or owed work. */
  readonly queuedMessages: JournalQueuedMessages
  readonly stopMarks: JournalStopMarks
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
        this.onCommitted?.()
      },
      notifyCommitted: () => this.onCommitted?.(),
      journal: () => this,
      enqueue: (build) => this.rowWriter.enqueue(build)
    })
    this.rowWriter = collaborators.rowWriter
    this.epochController = collaborators.epochController
    this.itemAppender = collaborators.itemAppender
    this.lifecycleBatchAppender = collaborators.lifecycleBatchAppender
    this.submissionWriter = collaborators.submissionWriter
    this.stepWriter = collaborators.stepWriter
    this.queuedMessages = collaborators.queuedMessages
    this.stopMarks = collaborators.stopMarks
    this.restore = collaborators.restore
    this.context = new JournalContextController({
      state: () => this.state,
      writer: this.rowWriter,
      cards: this.queuedMessages
    })
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

  /** Where the reopen's pause begins when this handle could not write its mark: where the mark
   *  would have gone. Null once a mark is written. Per handle, so the next open marks again. */
  reopenFloor(): AgentJournalCursor | null {
    return this.reopenUnmarked
  }

  async open(): Promise<void> {
    await this.restore()
    this.openedThrough = this.cursor()
  }

  /** Refuses every later write and resolves once the admitted ones have landed. Holds no
   *  connection, so there is nothing to release and nothing that can fail. */
  close(): Promise<void> {
    this.queuedMessages.editLeases.dispose()
    this.queue.markClosed()
    return this.queue.drain()
  }

  /** Told of every durable change, epoch replacements included, so a reader learns of a write
   *  without its writer saying so. One listener: a later call replaces it. It must not throw. */
  observeCommits(listener: () => void): void {
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

  /** One reduced item with its attribution, for a writer that needs the turn a row joined. */
  item = (itemId: string): AgentJournalRenderItem | null => this.state.items.get(itemId) ?? null

  /** Visits reduced items with the producer that wrote each, for a producer re-deriving what an
   *  earlier run of this session left. */
  visitItemsWithLinkage = (visit: JournalItemLinkageVisitor): void => {
    for (const item of this.state.items.values()) {
      visit(item.itemId, item.sequence, item.body, item)
    }
  }

  /** The turn this journal has published as running — the same read a client's snapshot gives,
   *  without materialising one. */
  activeTurnId = (): string | null =>
    activeStructuredAgentSessionTurnIdBySequence(this.state.items.values())

  /** Where a row written now belongs: the running turn, or the conversation. */
  liveTurnScope = (): AgentJournalTurnScope =>
    liveStructuredAgentSessionTurnScope(this.state.items.values())

  /** The newest turn record whatever state it settled in, for readers that need the outcome. */
  newestTurn = (): AgentJournalTurnLifecycle | null =>
    newestStructuredAgentSessionTurnBySequence(this.state.items.values())

  /** The latest goal the whole journal records, not only a client's loaded page. */
  threadGoal = (): AgentJournalThreadGoal | null =>
    currentAgentSessionThreadGoalBySequence(this.state.items.values()) ?? null

  /** The newest context facts the whole journal records, not only a client's loaded page. */
  contextUsage = (): AgentSessionContextUsage =>
    latestStructuredAgentContextFacts(this.state.items.values())

  /** Includes revisions and completion tombstones, whose timestamps disappear from render items. */
  lastActivityAt = (): number => this.state.lastActivityAt

  /** Fence of the writer that created the item, while it is in the timeline. */
  itemFence = (itemId: string): number | undefined => this.state.itemFences.get(itemId)

  /** Latest saved output at this fence, excluding client actions and recovery bookkeeping. */
  lastProviderActivityAt = (fence: number): number | undefined =>
    this.state.providerActivityAt.get(fence)

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
    options: JournalItemAppendOptions
  ): Promise<JournalAppendResult> {
    return this.itemAppender.append(identity, body, options)
  }

  /** An upsert whose row is chosen from the fold at its own turn in the queue; null writes nothing. */
  appendResolvedItem: JournalItemAppender['appendResolved'] = (resolve, options) =>
    this.itemAppender.appendResolved(resolve, options)

  appendTombstone(
    identity: AgentJournalItemIdentity,
    options: JournalTombstoneInput
  ): Promise<AgentJournalCursor> {
    const itemId = agentJournalItemKey(identity)
    return this.rowWriter.append(
      journalTombstoneRowBuilder(() => this.state, itemId, options.fence)
    )
  }

  /** A Stop that took effect, timed by its row (`JournalStopEvent`). */
  appendStopEvent(event: Omit<JournalStopEvent, 'at'>, fence: number): Promise<AgentJournalCursor> {
    return this.rowWriter.append(journalStopEventRowBuilder(() => this.state, event, fence))
  }

  /** A person's Resume of the queue. */
  appendQueueResume(fence: number): Promise<AgentJournalCursor> {
    return this.rowWriter.append(journalQueueResumeRowBuilder(() => this.state, fence))
  }

  /** This open found waiting cards an earlier handle wrote (`queued-message-pause.ts`). */
  appendQueueReopen(fence: number, since?: number): Promise<AgentJournalCursor> {
    return this.rowWriter.append(journalQueueReopenRowBuilder(() => this.state, fence, since))
  }

  /** Marks the reopen when a card waits or is mid-hand-off (it may come back to waiting), from
   *  `since` when the chat stopped before now; a failed write leaves where the mark would have gone
   *  as the pause's start (`reopenFloor`), and throws. */
  async markQueueReopen(fence: number, since?: number): Promise<void> {
    if (this.queuedMessages.awaitReopenMark()) {
      const sequence = since ?? this.state.lastSequence + 1
      this.reopenUnmarked = { epoch: this.state.epoch, sequence }
      await this.appendQueueReopen(fence, since)
      this.reopenUnmarked = null
    }
  }

  appendLifecycleBatch(input: JournalLifecycleBatchInput): Promise<AgentJournalCursor> {
    return this.lifecycleBatchAppender.append(input)
  }

  /** Several writes as one turn in the queue; see `JournalStepWriter`. */
  appendSteps: JournalStepWriter['append'] = (steps) => this.stepWriter.append(steps)

  /** The write-ahead submission row (`JournalSubmissionWriter.append`). */
  appendSubmission(
    input: JournalSubmissionInput,
    consume?: JournalSubmissionConsume,
    receipt?: JournalOperationReceipt
  ): Promise<AgentJournalCursor> {
    return this.submissionWriter.append(input, consume, receipt)
  }

  /** A dispatch transition (`JournalSubmissionWriter.resolveDispatch`). */
  resolveDispatch(
    input: ResolveDispatchInput,
    hook?: JournalRowTransactionHook
  ): Promise<AgentJournalCursor> {
    return this.submissionWriter.resolveDispatch(input, hook)
  }

  /** Retire unanswered sends after their execution owner ended, without assuming delivery. */
  async markPendingSubmissionsUnknown(fence: number, reason?: string): Promise<string[]> {
    return markJournalPendingSubmissionsUnknown(this, fence, reason)
  }

  /** Reject sends a child that ended in its start was handed and never echoed: none ran. */
  async rejectPendingSubmissions(
    fence: number,
    rejection: AgentJournalDispatchRejection
  ): Promise<string[]> {
    return rejectJournalPendingSubmissions(this, fence, rejection)
  }

  /** Reject sends accepted but never handed over, optionally only those `which` names. */
  async rejectQueuedSubmissions(
    fence: number,
    rejection: AgentJournalDispatchRejection,
    which?: (submission: AgentJournalSubmission) => boolean
  ): Promise<string[]> {
    return rejectJournalQueuedSubmissions(this, fence, rejection, which)
  }

  /** The escape hatch for a forked handle and an unreadable schema. It invalidates every cursor;
   *  clients reload. */
  async rollEpoch(reason: AgentJournalEpochReason, fence: number): Promise<AgentJournalCursor> {
    return this.epochController.roll(reason, fence)
  }

  replaceEpochItems(
    reason: AgentJournalEpochReason,
    fence: number,
    items: readonly JournalReplacementItem[]
  ): Promise<AgentJournalCursor> {
    return this.epochController.replace(reason, fence, items)
  }

  private adoptLoadedJournal(loaded: JournalLoad): void {
    this.state = loaded.state
  }
}
