// The append-only journal store for one agent session.
//
// Sequence assignment and durable writes share one queue. Every mutation also
// carries a runtime fence so a superseded writer cannot re-enter that queue.

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
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { compactJournal, type JournalCompactionPolicy } from './journal-compaction'
import { resolveJournalResume, type JournalResume } from './journal-cursor'
import { publishNewEpoch } from './journal-epoch-rollover'
import {
  JournalAppendStorage,
  type JournalBlobPayload,
  type JournalItemAppendOptions
} from './journal-append-storage'
import { ensureJournalDir } from './journal-log-file'
import { loadJournal } from './journal-open'
import { DEFAULT_JOURNAL_PAYLOAD_LIMITS, type JournalPayloadLimits } from './journal-payload-bounds'
import {
  applyJournalRow,
  createJournalReducerState,
  renderJournalState,
  type JournalReducerState
} from './journal-reducer'
import type { AgentJournalEpochReason, JournalRow } from './journal-row-schema'
import { journalRowBase } from './journal-row-base'
import { assertJournalFence, assertJournalWritable } from './journal-write-guards'

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

export type JournalAppendResult = { cursor: AgentJournalCursor; itemId: string; revision: number }

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
  private readonly storage: JournalAppendStorage
  private readonly compaction: JournalCompactionPolicy | undefined
  private readonly now: () => number
  private readonly mintEpoch: () => string

  private state: JournalReducerState
  private tailRows: JournalRow[] = []
  private compactedThrough = 0
  private readOnly = false
  /** Serializes sequence assignment with the durable write behind it. */
  private writes: Promise<unknown> = Promise.resolve()

  constructor(options: AgentSessionJournalOptions) {
    this.identity = options.identity
    this.journalDir = options.journalDir
    const limits = options.limits ?? DEFAULT_JOURNAL_PAYLOAD_LIMITS
    this.storage = new JournalAppendStorage(options.identity.sessionId, options.journalDir, limits)
    this.compaction = options.compaction
    this.now = options.now ?? (() => Date.now())
    this.mintEpoch = options.mintEpoch ?? randomUUID
    this.state = createJournalReducerState(options.identity.sessionId, '')
  }

  get isReadOnly(): boolean {
    return this.readOnly || this.storage.isPoisoned
  }

  get epoch(): string {
    return this.state.epoch
  }

  get directory(): string {
    return this.journalDir
  }

  /** Rows at or below this snapshot sequence are no longer replayable. */
  get compactionBoundary(): number {
    return this.compactedThrough
  }

  async open(): Promise<void> {
    await ensureJournalDir(this.journalDir)
    await this.storage.open()
    const loaded = await loadJournal(this.journalDir, this.identity.sessionId)
    if (!loaded) {
      await this.startEpoch('session_created', 0)
      return
    }
    this.state = loaded.state
    this.tailRows = loaded.tailRows
    this.compactedThrough = loaded.compactedThrough
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

  /** Durable send result used to deduplicate reconnects. */
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

  /** Upsert by stable identity with a host-assigned revision. */
  appendItem(
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    options: JournalItemAppendOptions = { fence: 0 }
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
        ...journalRowBase(this.state.epoch, seq, options.fence, options.observedAt ?? ts),
        ...(options.recovered ? { recovered: options.recovered } : {})
      }
    }, options.blobs).then((row) => ({
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
      return {
        kind: 'tombstone',
        itemId,
        revision,
        ...journalRowBase(this.state.epoch, seq, options.fence, ts)
      }
    }).then((row) => ({ epoch: row.epoch, sequence: row.seq }))
  }

  /** Durable write-ahead row and optimistic user bubble. */
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
      ...journalRowBase(this.state.epoch, seq, input.fence, ts)
    })).then((row) => ({ epoch: row.epoch, sequence: row.seq }))
  }

  /** Settle a submission. Accepted rows adopt the provider's stable identity. */
  resolveDispatch(input: ResolveDispatchInput): Promise<AgentJournalCursor> {
    const providerItemId =
      input.state === 'accepted' ? agentJournalItemKey(input.providerIdentity) : null
    return this.enqueue((seq, ts) => ({
      kind: 'dispatch',
      clientMessageId: input.clientMessageId,
      state: input.state,
      providerItemId,
      reason: input.state === 'accepted' ? null : (input.reason ?? null),
      ...journalRowBase(this.state.epoch, seq, input.fence, ts),
      ...(input.recovered ? { recovered: input.recovered } : {})
    })).then((row) => ({ epoch: row.epoch, sequence: row.seq }))
  }

  /** Restarted pending submissions become unknown; Orca never re-sends them. */
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
    await this.serialize(async () => {
      this.assertMutationWritable()
      let result
      try {
        result = await compactJournal({
          journalDir: this.journalDir,
          state: this.state,
          tailRows: this.tailRows,
          policy: this.compaction,
          now: this.now()
        })
      } catch (error) {
        await this.storage.remeasureAfterMutation()
        throw error
      }
      this.tailRows = result.tailRows
      this.compactedThrough = result.compactedThrough
      this.state.oldestSequence = result.oldestSequence
      await this.storage.remeasureAfterMutation()
    })
  }

  /** Roll away an invalid journal prefix and force client snapshot reload. */
  async rollEpoch(reason: AgentJournalEpochReason, fence: number): Promise<AgentJournalCursor> {
    return this.serialize(async () => {
      this.assertMutationWritable()
      await this.startEpoch(reason, fence)
      return this.cursor()
    })
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
    this.compactedThrough = 1
    await this.storage.remeasureAfterMutation()
  }

  /** Assign, persist, and reduce one row in the same serialized step. */
  private enqueue(
    build: (seq: number, ts: number) => JournalRow,
    blobs: readonly JournalBlobPayload[] = []
  ): Promise<JournalRow> {
    return this.serialize(async () => {
      this.assertMutationWritable()
      const ts = this.now()
      const row = build(this.state.lastSequence + 1, ts)
      assertJournalFence(row.fence, this.state.highestFence)
      await this.storage.append(row, ts, blobs)
      applyJournalRow(this.state, row)
      this.tailRows.push(row)
      return row
    })
  }

  private assertMutationWritable(): void {
    assertJournalWritable(this.readOnly, this.identity.sessionId)
    this.storage.assertWritable()
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writes.then(operation)
    this.writes = run.catch(() => undefined)
    return run
  }
}
