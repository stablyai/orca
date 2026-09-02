// Append-only journal store for one agent session.

import { randomUUID } from 'node:crypto'
import type {
  AgentJournalAcceptanceReceipt,
  AgentJournalCursor,
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalSnapshot,
  AgentJournalSubmission,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  compactJournal,
  DEFAULT_JOURNAL_COMPACTION_POLICY,
  type JournalCompactionPolicy
} from './journal-compaction'
import type { JournalReplacementItem } from './journal-epoch-replacement'
import { readJournalSince } from './journal-cursor'
import type { JournalLoad } from './journal-open'
import { DEFAULT_JOURNAL_PAYLOAD_LIMITS } from './journal-payload-bounds'
import { markJournalPendingSubmissionsUnknown } from './journal-pending-submission-recovery'
import {
  applyJournalRow,
  createJournalReducerState,
  referencedBlobDigests,
  renderJournalState,
  resolveJournalItemId,
  type JournalReducerState
} from './journal-reducer'
import {
  journalDispatchRowBuilder,
  journalSubmissionRowBuilder,
  journalTombstoneRowBuilder
} from './journal-row-builders'
import type {
  AgentSessionJournalOptions,
  JournalAppendResult,
  JournalBlobInput,
  JournalItemAppendOptions,
  JournalLifecycleBatchInput,
  JournalReadSince,
  JournalSubmissionInput,
  JournalTombstoneInput,
  ResolveDispatchInput
} from './journal-store-contracts'
import type { AgentJournalEpochReason, JournalRow } from './journal-row-schema'
import { assertJournalWritable, JournalAppendBudget } from './journal-write-guards'
import { journalDirectoryBytes } from './journal-physical-quota'
import type { JournalLifecycleReservation } from './journal-lifecycle-capacity'
import { JournalLifecycleAdmission } from './journal-lifecycle-admission'
import { JournalRowWriter } from './journal-row-writer'
import { JournalEpochController } from './journal-epoch-controller'
import { journalStoreLoadedFields, openJournalStoreState } from './journal-store-open'
import { JournalItemAppender } from './journal-item-appender'
import { JournalLifecycleBatchAppender } from './journal-lifecycle-batch-appender'

export { AgentSessionJournalError } from './journal-write-guards'

export class AgentSessionJournal {
  private readonly identity: AgentSessionJournalIdentity
  private readonly journalDir: string
  private readonly budget: JournalAppendBudget
  private readonly compaction: JournalCompactionPolicy
  private readonly autoCompact: boolean
  private readonly now: () => number
  private readonly mintEpoch: () => string
  private readonly loaded: JournalLoad | null | undefined

  private state: JournalReducerState
  private tailRows: JournalRow[] = []
  private compactedThrough = 0
  private sizeBytes = 0
  private readOnly = false
  private malformedRows = 0
  private readonly lifecycleAdmission: JournalLifecycleAdmission
  private readonly rowWriter: JournalRowWriter
  private readonly epochController: JournalEpochController
  private readonly itemAppender: JournalItemAppender
  private readonly lifecycleBatchAppender: JournalLifecycleBatchAppender
  /** Serializes sequence assignment with the durable write behind it. */
  private writes: Promise<unknown> = Promise.resolve()

  constructor(options: AgentSessionJournalOptions) {
    this.identity = options.identity
    this.journalDir = options.journalDir
    this.budget = new JournalAppendBudget(
      options.identity.sessionId,
      options.limits ?? DEFAULT_JOURNAL_PAYLOAD_LIMITS
    )
    this.autoCompact = options.autoCompact ?? true
    this.compaction = options.compaction ?? DEFAULT_JOURNAL_COMPACTION_POLICY
    this.now = options.now ?? (() => Date.now())
    this.mintEpoch = options.mintEpoch ?? randomUUID
    this.loaded = options.loaded
    this.state = createJournalReducerState(options.identity.sessionId, '')
    this.lifecycleAdmission = new JournalLifecycleAdmission(
      options.identity.sessionId,
      this.budget.maxSessionBytes,
      (itemId) => resolveJournalItemId(this.state, itemId),
      this.budget.maxAppendsPerWindow
    )
    this.rowWriter = new JournalRowWriter({
      journalDir: this.journalDir,
      sessionId: options.identity.sessionId,
      budget: this.budget,
      lifecycleAdmission: this.lifecycleAdmission,
      autoCompact: this.autoCompact,
      compaction: this.compaction,
      now: this.now,
      serialize: (run) => this.serializeWrite(run),
      readOnly: () => this.readOnly,
      setReadOnly: (readOnly) => {
        this.readOnly = readOnly
      },
      physicalBytes: () => this.sizeBytes,
      highestFence: () => this.state.highestFence,
      nextSequence: () => this.state.lastSequence + 1,
      tailRows: () => this.tailRows,
      referencedBlobDigests: () => referencedBlobDigests(this.state),
      compact: (now, policy) => this.compact(now, policy),
      commit: (row, physicalBytes) => {
        applyJournalRow(this.state, row)
        this.tailRows.push(row)
        this.sizeBytes = physicalBytes
      }
    })
    this.epochController = new JournalEpochController({
      identity: this.identity,
      journalDir: this.journalDir,
      budget: this.budget,
      compaction: this.compaction,
      now: this.now,
      mintEpoch: this.mintEpoch,
      serialize: (run) => this.serializeWrite(run),
      readOnly: () => this.readOnly,
      setReadOnly: (readOnly) => {
        this.readOnly = readOnly
      },
      highestFence: () => this.state.highestFence,
      cursor: this.cursor,
      adopt: (loaded) => this.adoptLoadedJournal(loaded)
    })
    this.itemAppender = new JournalItemAppender({
      journal: () => this,
      state: () => this.state,
      enqueue: (build, blobs) => this.enqueue(build, blobs)
    })
    this.lifecycleBatchAppender = new JournalLifecycleBatchAppender({
      state: () => this.state,
      cursor: this.cursor,
      enqueue: (build) => this.enqueue(build)
    })
  }

  get isReadOnly(): boolean {
    return this.readOnly
  }

  get epoch(): string {
    return this.state.epoch
  }

  get directory(): string {
    return this.journalDir
  }

  /** Highest sequence folded into the snapshot; rows at or below it are no
   *  longer individually replayable. */
  get compactionBoundary(): number {
    return this.compactedThrough
  }

  async open(): Promise<void> {
    await openJournalStoreState({
      journalDir: this.journalDir,
      sessionId: this.identity.sessionId,
      maxBytes: this.budget.maxSessionBytes,
      loaded: this.loaded,
      start: () => this.epochController.start('session_created', 0),
      adopt: (loaded) => this.adoptLoadedJournal(loaded),
      tailRows: () => this.tailRows,
      snapshot: this.snapshot,
      rebuildLifecycle: (snapshot, bytes) => this.lifecycleAdmission.rebuild(snapshot, bytes),
      appendDisclosure: (identity, body, fence) => this.appendItem(identity, body, { fence }),
      highestFence: () => this.state.highestFence,
      malformedRows: () => this.malformedRows,
      readOnly: () => this.readOnly,
      setPhysicalBytes: (bytes) => {
        this.sizeBytes = bytes
      }
    })
  }

  cursor = (): AgentJournalCursor => ({
    epoch: this.state.epoch,
    sequence: this.state.lastSequence
  })

  snapshot = (): AgentJournalSnapshot => renderJournalState(this.state)

  submissions = (): AgentJournalSubmission[] => [...this.state.submissions.values()]

  pendingSubmissions = (): AgentJournalSubmission[] =>
    this.submissions().filter((entry) => entry.dispatchState === 'pending')

  /** The durable answer to "did my send land?" — a reconnecting client asking
   *  again gets this instead of re-sending. */
  receiptFor = (clientMessageId: string): AgentJournalAcceptanceReceipt | null =>
    this.state.receipts.get(clientMessageId) ?? null

  canonicalItemId = (itemId: string): string => resolveJournalItemId(this.state, itemId)

  reserveLifecycleCapacity(token: JournalLifecycleReservation): Promise<boolean> {
    return this.serializeCapacityMutation(async () => {
      this.sizeBytes = await journalDirectoryBytes(this.journalDir)
      return this.lifecycleAdmission.reserve(token, this.sizeBytes)
    })
  }

  transferLifecycleCapacity(fromId: string, toId: string): Promise<boolean> {
    return this.serializeCapacityMutation(() => this.lifecycleAdmission.transfer(fromId, toId))
  }

  releaseLifecycleCapacity(id: string): Promise<void> {
    return this.serializeCapacityMutation(() => this.lifecycleAdmission.release(id))
  }

  lifecycleCapacityState = (): { reservedBytes: number; reservedAppendSlots: number } =>
    this.lifecycleAdmission.state

  readSince(cursor: AgentJournalCursor): JournalReadSince {
    return readJournalSince(
      { state: this.state, tailRows: this.tailRows, readOnly: this.readOnly },
      cursor,
      () => this.cursor()
    )
  }

  /** Upsert by stable identity. The revision is assigned here so a caller
   *  cannot accidentally publish a revision the reducer will drop. */
  appendItem(
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    options: JournalItemAppendOptions = { fence: 0 }
  ): Promise<JournalAppendResult> {
    return this.itemAppender.append(identity, body, options)
  }

  /** Blob-before-row admission on the same serialized path as sequence assignment. */
  appendItemWithBlobs(
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    blobs: readonly JournalBlobInput[],
    options: JournalItemAppendOptions = { fence: 0 }
  ): Promise<JournalAppendResult> {
    return this.itemAppender.appendWithBlobs(identity, body, blobs, options)
  }

  appendTombstone(
    identity: AgentJournalItemIdentity,
    options: JournalTombstoneInput
  ): Promise<AgentJournalCursor> {
    const itemId = agentJournalItemKey(identity)
    return this.enqueue(journalTombstoneRowBuilder(() => this.state, itemId, options.fence)).then(
      (row) => ({ epoch: row.epoch, sequence: row.seq })
    )
  }

  appendLifecycleBatch(input: JournalLifecycleBatchInput): Promise<AgentJournalCursor> {
    return this.lifecycleBatchAppender.append(input)
  }

  /**
   * Write-ahead submission row. It is durable before the caller dispatches
   * anything, and it doubles as the optimistic user bubble so an accepted echo
   * reconciles into an existing slot instead of appending a second copy.
   */
  appendSubmission(input: JournalSubmissionInput): Promise<AgentJournalCursor> {
    return this.enqueue(
      journalSubmissionRowBuilder(() => this.state, this.identity.providerHandle, input)
    ).then((row) => ({ epoch: row.epoch, sequence: row.seq }))
  }

  /**
   * Advance a submission to exactly one of accepted / rejected / unknown.
   *
   * Accepting REQUIRES the provider identity rather than a free-form id: the
   * adopted key is what the provider's echo will upsert into, so a mismatched
   * string here would silently give the user a second copy of their own message.
   */
  resolveDispatch(input: ResolveDispatchInput): Promise<AgentJournalCursor> {
    return this.enqueue(journalDispatchRowBuilder(() => this.state, input)).then((row) => ({
      epoch: row.epoch,
      sequence: row.seq
    }))
  }

  /** On restart every `pending` submission becomes `unknown` before the session
   *  accepts a writer. Orca never re-sends on the user's behalf. */
  async markPendingSubmissionsUnknown(fence: number): Promise<string[]> {
    return markJournalPendingSubmissionsUnknown(this, fence)
  }

  async compact(
    now = this.now(),
    policy: JournalCompactionPolicy = this.compaction
  ): Promise<void> {
    assertJournalWritable(this.readOnly, this.identity.sessionId)
    const result = await compactJournal({
      journalDir: this.journalDir,
      state: this.state,
      tailRows: this.tailRows,
      policy,
      now,
      maxSessionBytes: this.budget.maxSessionBytes,
      sessionId: this.identity.sessionId
    })
    this.tailRows = result.tailRows
    this.compactedThrough = result.compactedThrough
    this.state.oldestSequence = result.oldestSequence
    this.sizeBytes = await journalDirectoryBytes(this.journalDir)
  }

  /** The escape hatch for corruption, an unreconcilable prefix, a forked handle,
   *  and an unreadable schema. It invalidates every cursor; clients reload. */
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
    Object.assign(this, journalStoreLoadedFields(loaded))
  }

  /**
   * Assign the next sequence, make the row durable, and fold it through the
   * SAME reducer replay uses — all inside one serialized step, so concurrent
   * callers cannot interleave and mint the same sequence.
   */
  private enqueue(
    build: (seq: number, ts: number) => JournalRow,
    blobs: readonly JournalBlobInput[] = []
  ): Promise<JournalRow> {
    return this.rowWriter.enqueue(build, blobs)
  }

  private serializeCapacityMutation = <T>(runMutation: () => Promise<T> | T): Promise<T> =>
    this.serializeWrite(async () => runMutation())

  private serializeWrite<T>(runWrite: () => Promise<T>): Promise<T> {
    const run = this.writes.then(runWrite)
    this.writes = run.catch(() => undefined)
    return run
  }
}
