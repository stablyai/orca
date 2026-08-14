// The append-only journal store for one agent session.
//
// Sequence numbers are assigned inside the same serialized append that makes
// the row durable, so an `(epoch, sequence)` space has exactly one writer and
// no gaps or reuse. Every mutating call carries the runtime fence; a stale
// fence is rejected outright rather than merged or queued for the new owner.

import { randomUUID } from 'node:crypto'
import type {
  AgentJournalAcceptanceReceipt,
  AgentJournalCursor,
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalMessageItem,
  AgentJournalResetReason,
  AgentJournalSnapshot,
  AgentJournalSubmission,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { compactJournal, type JournalCompactionPolicy } from './journal-compaction'
import { resolveJournalResume, type JournalResume } from './journal-cursor'
import { publishNewEpoch } from './journal-epoch-rollover'
import { appendJournalRows, ensureJournalDir } from './journal-log-file'
import { loadJournal } from './journal-open'
import { DEFAULT_JOURNAL_PAYLOAD_LIMITS, type JournalPayloadLimits } from './journal-payload-bounds'
import {
  applyJournalRow,
  createJournalReducerState,
  renderJournalState,
  type JournalReducerState
} from './journal-reducer'
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

export type AgentSessionJournalOptions = {
  identity: AgentSessionJournalIdentity
  journalDir: string
  limits?: JournalPayloadLimits
  compaction?: JournalCompactionPolicy
  now?: () => number
  mintEpoch?: () => string
}

export type JournalReadSince =
  | { ok: true; rows: JournalRow[]; cursor: AgentJournalCursor }
  | { ok: false; reset: AgentJournalResetReason }

export type ResolveDispatchInput = {
  clientMessageId: string
  fence: number
  /** Set when crash reconciliation, not the live dispatch, settled this. */
  recovered?: true
} & (
  | { state: 'accepted'; providerIdentity: AgentJournalItemIdentity }
  | { state: 'rejected' | 'unknown'; reason?: string | null }
)

export type JournalAppendResult = {
  cursor: AgentJournalCursor
  itemId: string
  revision: number
}

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
  private readonly compaction: JournalCompactionPolicy | undefined
  private readonly now: () => number
  private readonly mintEpoch: () => string

  private state: JournalReducerState
  private tailRows: JournalRow[] = []
  private compactedThrough = 0
  private sizeBytes = 0
  private readOnly = false
  /** Serializes sequence assignment with the durable write behind it. */
  private writes: Promise<unknown> = Promise.resolve()

  constructor(options: AgentSessionJournalOptions) {
    this.identity = options.identity
    this.journalDir = options.journalDir
    this.budget = new JournalAppendBudget(
      options.identity.sessionId,
      options.limits ?? DEFAULT_JOURNAL_PAYLOAD_LIMITS
    )
    this.compaction = options.compaction
    this.now = options.now ?? (() => Date.now())
    this.mintEpoch = options.mintEpoch ?? randomUUID
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
    const loaded = await loadJournal(this.journalDir, this.identity.sessionId)
    if (!loaded) {
      await this.startEpoch('session_created', 0)
      return
    }
    this.state = loaded.state
    this.tailRows = loaded.tailRows
    this.compactedThrough = loaded.compactedThrough
    this.sizeBytes = loaded.sizeBytes
    this.readOnly = loaded.readOnly
    if (loaded.corrupt && !loaded.readOnly) {
      // A reader that observes a gap rolls the epoch rather than rendering a
      // partial timeline; clients take the snapshot reload they already handle.
      await this.rollEpoch('corruption', this.state.highestFence)
    }
  }

  cursor(): AgentJournalCursor {
    return { epoch: this.state.epoch, sequence: this.state.lastSequence }
  }

  snapshot(): AgentJournalSnapshot {
    return renderJournalState(this.state)
  }

  submissions(): AgentJournalSubmission[] {
    return [...this.state.submissions.values()]
  }

  pendingSubmissions(): AgentJournalSubmission[] {
    return this.submissions().filter((entry) => entry.dispatchState === 'pending')
  }

  /** The durable answer to "did my send land?" — a reconnecting client asking
   *  again gets this instead of re-sending. */
  receiptFor(clientMessageId: string): AgentJournalAcceptanceReceipt | null {
    return this.state.receipts.get(clientMessageId) ?? null
  }

  readSince(cursor: AgentJournalCursor): JournalReadSince {
    const resume = this.resume(cursor)
    if (!resume.ok) {
      return { ok: false, reset: resume.reset }
    }
    return {
      ok: true,
      rows: this.tailRows.filter((row) => row.seq > resume.afterSequence),
      cursor: this.cursor()
    }
  }

  private resume(cursor: AgentJournalCursor): JournalResume {
    if (this.readOnly) {
      return { ok: false, reset: 'schema_unreadable' }
    }
    return resolveJournalResume(
      {
        epoch: this.state.epoch,
        lastSequence: this.state.lastSequence,
        oldestSequence: this.state.oldestSequence
      },
      cursor
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
    return this.enqueue((seq, ts) => {
      const resolved = this.state.aliases.get(itemId) ?? itemId
      const revision = (this.state.items.get(resolved)?.revision ?? 0) + 1
      return {
        kind: 'item',
        itemId,
        revision,
        body,
        ...this.rowBase(seq, options.fence, options.observedAt ?? ts),
        ...(options.recovered ? { recovered: options.recovered } : {})
      }
    }).then((row) => ({
      cursor: { epoch: row.epoch, sequence: row.seq },
      itemId,
      revision: (row as Extract<JournalRow, { kind: 'item' }>).revision
    }))
  }

  appendTombstone(
    identity: AgentJournalItemIdentity,
    options: { fence: number }
  ): Promise<AgentJournalCursor> {
    const itemId = agentJournalItemKey(identity)
    return this.enqueue((seq, ts) => {
      const resolved = this.state.aliases.get(itemId) ?? itemId
      const revision = (this.state.items.get(resolved)?.revision ?? 0) + 1
      return { kind: 'tombstone', itemId, revision, ...this.rowBase(seq, options.fence, ts) }
    }).then((row) => ({ epoch: row.epoch, sequence: row.seq }))
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
    return this.enqueue((seq, ts) => ({
      kind: 'submission',
      clientMessageId: input.clientMessageId,
      payloadFingerprint: input.payloadFingerprint,
      providerHandle: this.identity.providerHandle,
      body: input.body,
      ...this.rowBase(seq, input.fence, ts)
    })).then((row) => ({ epoch: row.epoch, sequence: row.seq }))
  }

  /**
   * Advance a submission to exactly one of accepted / rejected / unknown.
   *
   * Accepting REQUIRES the provider identity rather than a free-form id: the
   * adopted key is what the provider's echo will upsert into, so a mismatched
   * string here would silently give the user a second copy of their own message.
   */
  resolveDispatch(input: ResolveDispatchInput): Promise<AgentJournalCursor> {
    const providerItemId =
      input.state === 'accepted' ? agentJournalItemKey(input.providerIdentity) : null
    return this.enqueue((seq, ts) => ({
      kind: 'dispatch',
      clientMessageId: input.clientMessageId,
      state: input.state,
      providerItemId,
      reason: input.state === 'accepted' ? null : (input.reason ?? null),
      ...this.rowBase(seq, input.fence, ts),
      ...(input.recovered ? { recovered: input.recovered } : {})
    })).then((row) => ({ epoch: row.epoch, sequence: row.seq }))
  }

  /** On restart every `pending` submission becomes `unknown` before the session
   *  accepts a writer. Orca never re-sends on the user's behalf. */
  async markPendingSubmissionsUnknown(fence: number): Promise<string[]> {
    const pending = this.pendingSubmissions().map((entry) => entry.clientMessageId)
    for (const clientMessageId of pending) {
      await this.resolveDispatch({
        clientMessageId,
        state: 'unknown',
        reason: 'host_restarted_before_acknowledgement',
        fence,
        recovered: true
      })
    }
    return pending
  }

  async compact(): Promise<void> {
    assertJournalWritable(this.readOnly, this.identity.sessionId)
    const result = await compactJournal({
      journalDir: this.journalDir,
      state: this.state,
      tailRows: this.tailRows,
      policy: this.compaction,
      now: this.now()
    })
    this.tailRows = result.tailRows
    this.compactedThrough = result.compactedThrough
    this.state.oldestSequence = result.oldestSequence
    this.sizeBytes = this.tailRows.reduce((total, row) => total + journalRowByteLength(row), 0)
  }

  /** The escape hatch for corruption, an unreconcilable prefix, a forked handle,
   *  and an unreadable schema. It invalidates every cursor; clients reload. */
  async rollEpoch(reason: AgentJournalEpochReason, fence: number): Promise<AgentJournalCursor> {
    assertJournalWritable(this.readOnly, this.identity.sessionId)
    await this.startEpoch(reason, fence)
    return this.cursor()
  }

  private async startEpoch(reason: AgentJournalEpochReason, fence: number): Promise<void> {
    const published = await publishNewEpoch({
      journalDir: this.journalDir,
      sessionId: this.identity.sessionId,
      providerHandle: this.identity.providerHandle,
      epoch: this.mintEpoch(),
      reason,
      fence,
      now: this.now()
    })
    this.state = published.state
    this.tailRows = [published.row]
    this.compactedThrough = 0
    this.sizeBytes = journalRowByteLength(published.row)
  }

  private rowBase(
    seq: number,
    fence: number,
    ts: number
  ): { v: number; epoch: string; seq: number; fence: number; ts: number } {
    return {
      v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
      epoch: this.state.epoch,
      seq,
      fence,
      ts
    }
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
      this.budget.assert(row, ts, this.sizeBytes)
      await appendJournalRows(this.journalDir, [row])
      applyJournalRow(this.state, row)
      this.tailRows.push(row)
      this.sizeBytes += journalRowByteLength(row)
      return row
    })
    this.writes = run.catch(() => undefined)
    return run
  }
}
