// Each session owns its fold and queue; all statements use the host's shared database connection.

import type { AgentJournalDispatchRejection } from '../../../shared/agent-session-failure-words'
import { randomUUID } from 'node:crypto'
import { createJournalPublicReader } from './journal-public-read'
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
  resolveJournalItemId,
  type JournalReducerState
} from './journal-reducer'
import { journalTombstoneRowBuilder } from './journal-row-builders'
import type {
  AgentSessionJournalOptions,
  JournalItemLinkageVisitor,
  JournalLifecycleBatchInput,
  JournalPlannedLifecycleBatchInput,
  JournalReadSince,
  JournalTombstoneInput
} from './journal-store-contracts'
import type { JournalQueuedMessages } from './journal-queued-messages'
import {
  journalQueueResumeRowBuilder,
  journalQueueReopenRowBuilder,
  journalStopEventRowBuilder
} from './journal-stop-and-resume-rows'
import type { AgentJournalEpochReason, JournalStopEvent, JournalRow } from './journal-row-schema'
import type { JournalOperationReceipt, JournalRowWriter } from './journal-row-writer'
import type { JournalSubmissionWriter } from './journal-submission-writer'
import type { JournalEpochController } from './journal-epoch-controller'
import { JournalWriteQueue } from './journal-write-queue'
import { journalItemExecutionFence, journalItemProvenance } from './journal-item-provenance'
import { createJournalStoreCollaborators } from './journal-store-collaborators'
import type { JournalItemAppender } from './journal-item-appender'
import type { JournalStepWriter } from './journal-step-writer'
import { journalThreadGoalSource, type JournalThreadGoalSource } from './journal-thread-goal-source'

export { AgentSessionJournalError } from './journal-write-guards'

type JournalCollaborators = ReturnType<typeof createJournalStoreCollaborators>

export class AgentSessionJournal {
  private readonly goalAttachments: JournalCollaborators['goalAttachments']
  private readonly identity: AgentSessionJournalIdentity
  private readonly database: JournalHostDatabase
  private readonly now: () => number
  private readonly mintEpoch: () => string

  private state: JournalReducerState
  private readonly readPublic = createJournalPublicReader()
  private openedThrough: AgentJournalCursor = { epoch: '', sequence: 0 }
  private reopenUnmarked: AgentJournalCursor | null = null
  private onCommitted: ((rows?: readonly JournalRow[]) => void) | null = null
  private readonly queue: JournalWriteQueue
  private readonly rowWriter: JournalRowWriter
  private readonly epochController: JournalEpochController
  private readonly itemAppender: JournalItemAppender
  private readonly lifecycleBatchAppender: JournalCollaborators['lifecycleBatchAppender']
  private readonly submissionWriter: JournalSubmissionWriter
  private readonly stepWriter: JournalStepWriter
  private readonly restore: () => Promise<void>
  /** Queued cards never count as owed work. */
  readonly queuedMessages: JournalQueuedMessages
  readonly stopMarks: JournalCollaborators['stopMarks']
  readonly stops: JournalCollaborators['stops']
  readonly context: JournalCollaborators['context']

  constructor(options: AgentSessionJournalOptions) {
    this.identity = options.identity
    this.database = options.database
    this.now = options.now ?? (() => Date.now())
    this.mintEpoch = options.mintEpoch ?? randomUUID
    this.state = createJournalReducerState(options.identity.sessionId, '')
    this.queue = new JournalWriteQueue(options.identity.sessionId)
    const collaborators = createJournalStoreCollaborators({
      identity: this.identity,
      now: this.now,
      mintEpoch: this.mintEpoch,
      serialize: (run) => this.queue.serialize(run),
      database: () => this.database,
      state: () => this.state,
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
    return this.state.epoch
  }

  get agent(): AgentSessionJournalIdentity['agent'] {
    return this.identity.agent
  }

  /** Only rows from this handle's opening epoch can predate the open. */
  wroteBeforeOpen(sequence: number | undefined): boolean {
    return (
      sequence !== undefined &&
      this.state.epoch === this.openedThrough.epoch &&
      sequence <= this.openedThrough.sequence
    )
  }

  /** Fallback reopen boundary until its mark is written; each new handle marks again. */
  reopenFloor(): AgentJournalCursor | null {
    return this.reopenUnmarked
  }

  async open(): Promise<void> {
    await this.restore()
    this.openedThrough = this.cursor()
  }

  /** Refuse future writes and drain admitted ones; the host retains database ownership. */
  close(): Promise<void> {
    this.queuedMessages.editLeases.dispose()
    this.queue.markClosed()
    return this.queue.drain()
  }

  /** One nonthrowing listener; undefined rows mean adopted history, an empty array means metadata. */
  observeCommits(listener: (rows?: readonly JournalRow[]) => void): void {
    this.onCommitted = listener
  }

  cursor = (): AgentJournalCursor => ({
    epoch: this.state.epoch,
    sequence: this.state.lastSequence
  })

  snapshot = (): AgentJournalSnapshot => this.publicRead().snapshot

  publicRead = () =>
    this.readPublic(this.state, this.queuedMessages.displayState(), this.queuedMessages.revision())

  /** Visit without allocating/sorting a snapshot. */
  visitItems = (
    visit: (itemId: string, sequence: number, body: AgentJournalItemBody) => void
  ): void => {
    for (const item of this.state.items.values()) {
      visit(item.itemId, item.sequence, item.body)
    }
  }

  itemBody = (itemId: string): AgentJournalItemBody | null =>
    this.state.items.get(itemId)?.body ?? null

  /** Host-only stopped-history IDs carried by each send. */
  stoppedHistoryCarried = (): ReadonlyMap<string, readonly string[]> =>
    this.state.stoppedHistoryCarried

  item = (itemId: string): AgentJournalRenderItem | null => this.state.items.get(itemId) ?? null

  visitItemsWithLinkage = (visit: JournalItemLinkageVisitor): void => {
    for (const item of this.state.items.values()) {
      visit(item.itemId, item.sequence, item.body, item)
    }
  }

  /** Read the journal's running turn without allocating a snapshot; host projection decides current work. */
  runningTurn = (): { item: AgentJournalRenderItem; turnId: string } | null =>
    runningStructuredAgentSessionTurnItemBySequence(this.state.items.values())

  newestTurn = (): AgentJournalTurnLifecycle | null =>
    newestStructuredAgentSessionTurnBySequence(this.state.items.values())

  threadGoalSource = (): JournalThreadGoalSource =>
    journalThreadGoalSource(this.state.items.values())

  /** Read across the journal, beyond any client's loaded page. */
  threadGoal = (): AgentJournalThreadGoal | null => this.threadGoalSource().goal

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

  submissions = (): AgentJournalSubmission[] => [...this.state.submissions.values()]

  historyOrigin = () => this.state.historyOrigin

  submission = (clientMessageId: string) => this.state.submissions.get(clientMessageId)

  pendingSubmissions = () => this.submissions().filter((entry) => entry.dispatchState === 'pending')

  /** Reconnecting clients read durable acceptance instead of resending. */
  receiptFor = (clientMessageId: string): AgentJournalAcceptanceReceipt | null =>
    this.state.receipts.get(clientMessageId) ?? null

  canonicalItemId = (itemId: string): string => resolveJournalItemId(this.state, itemId)

  /** Read after all preceding writes and before later ones. */
  readInOrder<T>(read: () => T): Promise<T> {
    return this.queue.readInOrder(read)
  }

  readSince(cursor: AgentJournalCursor, limit?: number): JournalReadSince {
    const { sessionId } = this.identity
    const rowsAfter = journalRowsAfterReader(this.database.db, sessionId, this.state.epoch, limit)
    return readJournalSince({ state: this.state, rowsAfter }, cursor, () => this.cursor())
  }

  /** Assign revisions here so callers cannot publish reducer-stale upserts. */
  appendItem(...args: Parameters<JournalItemAppender['append']>) {
    return this.itemAppender.append(...args)
  }

  appendClaimingAttachments: JournalItemAppender['appendClaimingAttachments'] = (...args) =>
    this.itemAppender.appendClaimingAttachments(...args)

  /** Resolve on the write lane; null appends nothing. */
  appendResolvedItem: JournalItemAppender['appendResolved'] = (resolve, options) =>
    this.itemAppender.appendResolved(resolve, options)

  appendTombstone(
    identity: AgentJournalItemIdentity,
    { fence }: JournalTombstoneInput,
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
    options: JournalTombstoneInput
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
      this.reopenUnmarked = null
    }
  }

  appendLifecycleBatch(input: JournalLifecycleBatchInput): Promise<AgentJournalCursor> {
    return this.lifecycleBatchAppender.append(input)
  }

  appendPlannedLifecycleBatch = (input: JournalPlannedLifecycleBatchInput) =>
    this.lifecycleBatchAppender.appendPlanned(input)

  appendSteps: JournalStepWriter['append'] = (steps) => this.stepWriter.append(steps)

  appendSubmission(...args: Parameters<JournalSubmissionWriter['append']>) {
    return this.submissionWriter.append(...args)
  }

  resolveDispatch(...args: Parameters<JournalSubmissionWriter['resolveDispatch']>) {
    return this.submissionWriter.resolveDispatch(...args)
  }

  acceptLate: JournalSubmissionWriter['acceptLate'] = (i) => this.submissionWriter.acceptLate(i)

  /** Retire unanswered sends after their execution owner ended, without assuming delivery. */
  async markPendingSubmissionsUnknown(fence: number, reason?: string): Promise<string[]> {
    return markJournalPendingSubmissionsUnknown(this, fence, reason)
  }

  /** Failed initialization proves handed-over but unanswered sends never ran. */
  async rejectPendingSubmissions(
    fence: number,
    rejection: AgentJournalDispatchRejection
  ): Promise<string[]> {
    return rejectJournalPendingSubmissions(this, fence, rejection)
  }

  rejectQueuedSubmissions = (
    fence: number,
    rejection: AgentJournalDispatchRejection,
    which?: (submission: AgentJournalSubmission) => boolean
  ): Promise<string[]> => rejectJournalQueuedSubmissions(this, fence, rejection, which)

  /** Epoch rollover invalidates every client cursor. */
  async rollEpoch(reason: AgentJournalEpochReason, fence: number): Promise<AgentJournalCursor> {
    return this.epochController.roll(reason, fence)
  }

  replaceEpochItems(
    ...args: Parameters<JournalEpochController['replace']>
  ): Promise<AgentJournalCursor> {
    return this.epochController.replace(...args)
  }

  private adoptLoadedJournal(loaded: JournalLoad): void {
    this.state = loaded.state
  }
}
