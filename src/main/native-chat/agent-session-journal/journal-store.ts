// Append-only journal store for one agent session.

import { randomUUID } from 'node:crypto'
import type {
  AgentJournalAcceptanceReceipt,
  AgentJournalCursor,
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalMessageItem,
  AgentJournalSnapshot,
  AgentJournalSubmission,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  budgetPressurePolicy,
  compactJournal,
  DEFAULT_JOURNAL_COMPACTION_POLICY,
  journalTailCanShedRows,
  journalTailIsReadyToCompact,
  type JournalCompactionPolicy
} from './journal-compaction'
import { replaceJournalEpoch, type JournalReplacementItem } from './journal-epoch-replacement'
import { readJournalSince } from './journal-cursor'
import { publishNewEpoch } from './journal-epoch-rollover'
import { appendJournalRows, ensureJournalDir } from './journal-log-file'
import {
  malformedRowsDisclosure,
  quarantineCorruptSuffix,
  quarantineUnreadableSchema
} from './journal-corruption-quarantine'
import { loadJournal, type JournalLoad } from './journal-open'
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
  journalItemRowBuilder,
  journalSubmissionRowBuilder,
  journalTombstoneRowBuilder
} from './journal-row-builders'
import type {
  AgentSessionJournalOptions,
  JournalAppendResult,
  JournalReadSince,
  ResolveDispatchInput
} from './journal-store-contracts'
import {
  journalRowByteLength,
  type AgentJournalEpochReason,
  type JournalRow
} from './journal-row-schema'
import {
  assertJournalFence,
  assertJournalWritable,
  JournalAppendBudget
} from './journal-write-guards'

export { AgentSessionJournalError } from './journal-write-guards'

export async function openAgentSessionJournal(
  options: AgentSessionJournalOptions
): Promise<AgentSessionJournal> {
  const journal = new AgentSessionJournal(options)
  await journal.open()
  return journal
}

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
    await ensureJournalDir(this.journalDir)
    const loaded =
      this.loaded !== undefined
        ? this.loaded
        : await loadJournal(this.journalDir, this.identity.sessionId)
    if (!loaded) {
      await this.startEpoch('session_created', 0)
      return
    }
    this.adoptLoadedJournal(loaded)
    if (loaded.corrupt && !loaded.readOnly) {
      // The epoch stays put: no intact history is discarded to recover.
      await quarantineCorruptSuffix(this.journalDir, this.tailRows, loaded.quarantineRemainder)
    }
    if (this.malformedRows > 0 && !this.readOnly) {
      const disclosure = malformedRowsDisclosure(this.malformedRows)
      await this.appendItem(disclosure.identity, disclosure.body, {
        fence: this.state.highestFence
      })
    }
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
  receiptFor(clientMessageId: string): AgentJournalAcceptanceReceipt | null {
    return this.state.receipts.get(clientMessageId) ?? null
  }

  canonicalItemId = (itemId: string): string => resolveJournalItemId(this.state, itemId)

  referencedBlobDigests(): Set<string> {
    return referencedBlobDigests(this.state)
  }

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
    options: { fence: number; observedAt?: number; recovered?: true } = { fence: 0 }
  ): Promise<JournalAppendResult> {
    const itemId = agentJournalItemKey(identity)
    return this.enqueue(journalItemRowBuilder(() => this.state, identity, body, options)).then(
      (row) => ({
        cursor: { epoch: row.epoch, sequence: row.seq },
        itemId,
        revision: (row as Extract<JournalRow, { kind: 'item' }>).revision
      })
    )
  }

  appendTombstone(
    identity: AgentJournalItemIdentity,
    options: { fence: number }
  ): Promise<AgentJournalCursor> {
    const itemId = agentJournalItemKey(identity)
    return this.enqueue(journalTombstoneRowBuilder(() => this.state, itemId, options.fence)).then(
      (row) => ({ epoch: row.epoch, sequence: row.seq })
    )
  }

  /**
   * Write-ahead submission row. It is durable before the caller dispatches
   * anything, and it doubles as the optimistic user bubble so an accepted echo
   * reconciles into an existing slot instead of appending a second copy.
   */
  appendSubmission(input: {
    clientMessageId: string
    payloadFingerprint: string
    body: AgentJournalMessageItem
    fence: number
  }): Promise<AgentJournalCursor> {
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
      maxSessionBytes: this.budget.maxSessionBytes
    })
    this.tailRows = result.tailRows
    this.compactedThrough = result.compactedThrough
    this.state.oldestSequence = result.oldestSequence
    this.sizeBytes = this.tailRows.reduce((total, row) => total + journalRowByteLength(row), 0)
  }

  /** The escape hatch for corruption, an unreconcilable prefix, a forked handle,
   *  and an unreadable schema. It invalidates every cursor; clients reload. */
  async rollEpoch(reason: AgentJournalEpochReason, fence: number): Promise<AgentJournalCursor> {
    if (reason !== 'schema_unreadable') {
      assertJournalWritable(this.readOnly, this.identity.sessionId)
    } else if (this.readOnly) {
      await quarantineUnreadableSchema(this.journalDir)
    }
    await this.startEpoch(reason, fence)
    this.readOnly = false
    return this.cursor()
  }

  replaceEpochItems(
    reason: AgentJournalEpochReason,
    fence: number,
    items: readonly JournalReplacementItem[]
  ): Promise<AgentJournalCursor> {
    const run = this.writes.then(async () => {
      assertJournalWritable(this.readOnly, this.identity.sessionId)
      assertJournalFence(fence, this.state.highestFence)
      await replaceJournalEpoch({
        journalDir: this.journalDir,
        identity: this.identity,
        reason,
        fence,
        items,
        budget: this.budget.fork(),
        compaction: this.compaction,
        now: this.now,
        mintEpoch: this.mintEpoch,
        onSnapshotPublished: (loaded) => this.adoptLoadedJournal(loaded)
      })
      return this.cursor()
    })
    this.writes = run.catch(() => undefined)
    return run
  }

  private async startEpoch(reason: AgentJournalEpochReason, fence: number): Promise<void> {
    this.adoptLoadedJournal(
      await publishNewEpoch({
        journalDir: this.journalDir,
        sessionId: this.identity.sessionId,
        providerHandle: this.identity.providerHandle,
        epoch: this.mintEpoch(),
        reason,
        fence,
        now: this.now()
      })
    )
  }

  private adoptLoadedJournal(loaded: JournalLoad): void {
    this.state = loaded.state
    this.tailRows = loaded.tailRows
    this.compactedThrough = loaded.compactedThrough
    this.sizeBytes = loaded.sizeBytes
    this.readOnly = loaded.readOnly
    this.malformedRows = loaded.malformedRows
  }

  /**
   * Assign the next sequence, make the row durable, and fold it through the
   * SAME reducer replay uses — all inside one serialized step, so concurrent
   * callers cannot interleave and mint the same sequence.
   */
  private enqueue(build: (seq: number, ts: number) => JournalRow): Promise<JournalRow> {
    const run = this.writes.then(async () => {
      assertJournalWritable(this.readOnly, this.identity.sessionId)
      const ts = this.now()
      const row = build(this.state.lastSequence + 1, ts)
      assertJournalFence(row.fence, this.state.highestFence)
      const budgetCompaction = budgetPressurePolicy(this.compaction)
      if (
        this.autoCompact &&
        this.budget.wouldExceedSize(row, this.sizeBytes) &&
        journalTailCanShedRows(this.tailRows, budgetCompaction, ts)
      ) {
        await this.compact(ts, budgetCompaction)
      }
      this.budget.assert(row, ts, this.sizeBytes)
      await appendJournalRows(this.journalDir, [row])
      applyJournalRow(this.state, row)
      this.tailRows.push(row)
      this.sizeBytes += journalRowByteLength(row)
      // Nothing else calls compact(), so without this the log only ever grows —
      // until the size bound refuses every append for the rest of the session.
      if (this.autoCompact && journalTailIsReadyToCompact(this.tailRows, this.compaction, ts)) {
        await this.compact(ts)
      }
      return row
    })
    this.writes = run.catch(() => undefined)
    return run
  }
}
