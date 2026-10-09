// The journal's draft-store collaborator: every read and write of one session's
// `queued_messages` rows, serialized on the same queue as the journal's own
// appends so a draft mutation can never interleave with the consume that
// converts it. Drafts are NEVER owed work: nothing here feeds the reducer,
// working status, teardown, or the idle sweep.

import type Database from '../../sqlite/sync-database'
import type {
  AgentJournalCursor,
  AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'
import {
  AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS,
  AGENT_SESSION_OPERATION_FUTURE_SKEW_MS
} from '../../../shared/agent-session-host-authority'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import type { JournalOperationReceipt } from './journal-row-writer'
import type { JournalSubmissionConsume } from './journal-store-contracts'
import { holdQueuedMessages } from './queued-message-holds'
import {
  deriveQueuePauses,
  journalUserStopInForce,
  nextSendableQueuedCard,
  type DerivedQueuePause,
  type JournalQueuePauseMarks
} from './queued-message-pause'
import {
  consumeQueuedMessageInTransaction,
  getQueuedMessage,
  insertQueuedMessage,
  listQueuedMessages,
  queuedMessagesSettledByOp,
  withdrawQueuedMessages,
  type QueuedMessageHoldReason,
  type QueuedMessageRow
} from './queued-message-table'
import { draftsDeliveredByAppliedEcho } from './queued-message-delivered-echo'
import { moveQueuedMessages, type QueuedMessagePositionMove } from './queued-message-positions'
import { pruneQueuedMessages, retainedSubmissionVerdict } from './queued-message-retention'
import {
  queuedMessageSettlementOwed,
  settleOwedQueuedMessages,
  settleQueuedMessagesForRow
} from './queued-message-settlement'
import { AgentSessionJournalError, assertJournalWritable } from './journal-write-guards'
import type { JournalAttachmentClaim } from './journal-submission-hook'
import type { JournalWriteBody, JournalWriteResult } from './journal-write-queue'
import { QueuedMessageNotConsumableError } from './queued-message-consume-error'
export { QueuedMessageNotConsumableError } from './queued-message-consume-error'

/** Tombstones must outlive the window in which their operation id could still be admitted as new. */
export const QUEUED_MESSAGE_REPLAY_WINDOW_MS =
  AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS + AGENT_SESSION_OPERATION_FUTURE_SKEW_MS

export type JournalQueuedMessagesDeps = {
  sessionId: string
  now: () => number
  serialize: <T>(run: JournalWriteBody<T>) => Promise<T>
  database: () => JournalHostDatabase
  readOnly: () => boolean
  state: () => JournalReducerState
  /** Where the reopen's pause begins when this handle could not mark it (`reopenFloor`). */
  reopenFloor: () => AgentJournalCursor | null
  /** The journal's own commit notification. Every standalone draft-table
   *  transaction that changed rows fires it after COMMIT, so a draft or hold
   *  change publishes and wakes the drain through the same path a journal row
   *  does — no call site can forget. In-transaction consume and the returned
   *  transition already ride their row's own commit. */
  committed: () => void
  claimAttachments: JournalAttachmentClaim
}

export class JournalQueuedMessages {
  /** Bumped on every draft-table write, so publication memos recompute only when they must. */
  private changeRevision = 0
  private listed: { revision: number; rows: readonly QueuedMessageRow[] } | null = null

  constructor(private readonly deps: JournalQueuedMessagesDeps) {}

  get sessionId(): string {
    return this.deps.sessionId
  }

  revision(): number {
    return this.changeRevision
  }

  /** A journal transaction rolled back: nothing read inside it may stay cached. */
  invalidate(): void {
    this.changeRevision++
  }

  /** Cached per revision: the drain re-checks on every journal publish, so an
   *  unchanged table must cost no SQL read or body parse on token streams. */
  list(): readonly QueuedMessageRow[] {
    if (this.listed?.revision !== this.changeRevision) {
      this.listed = {
        revision: this.changeRevision,
        rows: listQueuedMessages(this.deps.database().db, this.deps.sessionId)
      }
    }
    return this.listed.rows
  }

  get(messageId: string): QueuedMessageRow | null {
    return getQueuedMessage(this.deps.database().db, this.deps.sessionId, messageId)
  }

  /** Replay receipts for one caller-scoped operation key. */
  receipts(settledByOp: string): QueuedMessageRow[] {
    return queuedMessagesSettledByOp(this.deps.database().db, this.deps.sessionId, settledByOp)
  }

  /** Attachments and the send receipt commit with the card. */
  insert(
    input: {
      messageId: string
      body: AgentJournalMessageItem
      fingerprint: string
      hostInstance: string
      requireAttachments?: true
      holdReason?: QueuedMessageHoldReason
    },
    receipt?: JournalOperationReceipt
  ): Promise<QueuedMessageRow> {
    const { sessionId } = this.deps
    const { requireAttachments, ...draft } = input
    let inserted = false
    return this.transact(
      (db) => {
        const existing = getQueuedMessage(db, sessionId, input.messageId)
        if (existing) {
          // One id, one draft: admission replays a recorded operation before it
          // gets here, so an existing row is the same accept landing twice.
          return existing
        }
        this.deps.claimAttachments(db, input.body, requireAttachments === true)
        inserted = true
        const { epoch, lastSequence } = this.deps.state()
        const row = insertQueuedMessage(db, {
          ...draft,
          sessionId,
          queuedAt: { epoch, sequence: lastSequence },
          now: this.deps.now()
        })
        receipt?.write(db)
        return row
      },
      () => inserted,
      receipt?.committed
    )
  }

  /** Hold one waiting draft whose conversion failed. Stored on the row, so it
   *  survives handle eviction and restart; withdraw and consume clear it in their
   *  own UPDATE. */
  hold(input: { messageIds: readonly string[]; reason: QueuedMessageHoldReason }): Promise<void> {
    return this.transact(
      (db) => holdQueuedMessages(db, { ...input, sessionId: this.deps.sessionId }),
      (held) => held > 0
    ).then(() => undefined)
  }

  /** The queue's pauses in force, derived from the fold and the cards (`queued-message-pause.ts`). */
  pauses(): DerivedQueuePause[] {
    return this.derivePauses(this.list())
  }

  /** A card waits, or is mid-hand-off and may come back to waiting: a chat that stops running
   *  marks it (`AgentSessionJournal.markQueueReopen`). */
  awaitReopenMark(): boolean {
    const { submissions } = this.deps.state()
    return this.list().some((row) => {
      if (row.state === 'waiting') {
        return true
      }
      const handOff = row.consumedAs ? submissions.get(row.consumedAs)?.dispatchState : undefined
      return row.state === 'dispatched' && (handOff === 'pending' || handOff === 'unknown')
    })
  }

  /** The person's Stop still pausing the queue, if any (`journalUserStopInForce`). */
  userStopInForce(): JournalQueuePauseMarks['latestStop'] {
    const state = this.deps.state()
    return journalUserStopInForce(state.queuePauseMarks, state.latestAcceptedTurnSequence)
  }

  private derivePauses(cards: readonly QueuedMessageRow[]): DerivedQueuePause[] {
    const state = this.deps.state()
    return deriveQueuePauses({
      epoch: state.epoch,
      marks: state.queuePauseMarks,
      latestAcceptedTurnSequence: state.latestAcceptedTurnSequence,
      cards,
      reopenFloor: this.deps.reopenFloor()
    })
  }

  /** Inside the caller's journal-row transaction (`journal-unsent-send-hold.ts`): one kept send
   *  becomes a card, and the cards ahead of the queue take the positions given. False when a card
   *  by that id already exists, which then stands. */
  holdInTransaction(
    db: Database.Database,
    input: {
      card: Omit<Parameters<typeof insertQueuedMessage>[1], 'sessionId' | 'now'> | null
      positions: readonly QueuedMessagePositionMove[]
    }
  ): boolean {
    const { sessionId } = this.deps
    this.changeRevision += moveQueuedMessages(db, sessionId, input.positions)
    if (!input.card || getQueuedMessage(db, sessionId, input.card.messageId)) {
      return false
    }
    insertQueuedMessage(db, { ...input.card, sessionId, now: this.deps.now() })
    this.changeRevision++
    return true
  }

  /** Compare-and-transition waiting ∪ returned rows to op-stamped tombstones,
   *  kept only so a replay of the settling operation answers "spent". */
  withdraw(input: {
    messageIds: readonly string[]
    settledByOp: string
  }): Promise<QueuedMessageRow[]> {
    if (input.messageIds.length === 0) {
      // Delete races and empty carries land here; neither may cost a write transaction.
      return Promise.resolve([])
    }
    return this.transact(
      (db) =>
        withdrawQueuedMessages(db, {
          ...input,
          sessionId: this.deps.sessionId,
          now: this.deps.now()
        }),
      (withdrawn) => withdrawn.length > 0
    )
  }

  /** Withdraw commands with the clear's divider and receipt on the same connection. */
  withdrawInTransaction(
    db: Database.Database,
    input: { messageIds: readonly string[]; settledByOp: string }
  ): string[] {
    if (this.deps.database().db !== db) {
      throw new AgentSessionJournalError('journal_closed', 'withdraw crossed database handles')
    }
    const { sessionId, now } = this.deps
    const withdrawn = withdrawQueuedMessages(db, { ...input, sessionId, now: now() })
    this.changeRevision += withdrawn.length
    return withdrawn.map((row) => row.messageId)
  }

  /** One standalone draft-table transaction on the journal's queue; one that
   *  changed rows bumps the revision and notifies after COMMIT, `adopted` first. Open to the
   *  draft-table writers outside this file (`queued-message-return.ts`), which take no other path. */
  transact<T>(
    run: (db: Database.Database) => JournalWriteResult<T>,
    changed: (result: T) => boolean,
    adopted?: () => void
  ): Promise<T> {
    return this.deps.serialize(() => {
      assertJournalWritable(this.deps.readOnly(), this.deps.sessionId)
      const result = this.deps.database().transaction(run)
      if (changed(result)) {
        adopted?.()
        this.changeRevision++
        this.deps.committed()
      }
      return result
    })
  }

  /** The standing writer hook, within the append's transaction
   *  (`settleQueuedMessagesForRow`). */
  onRowInTransaction(db: Database.Database, row: JournalRow): void {
    this.changeRevision += settleQueuedMessagesForRow(db, {
      sessionId: this.deps.sessionId,
      state: this.deps.state(),
      drafts: () => this.list(),
      row,
      now: this.deps.now()
    })
  }

  /** The in-transaction consume for `appendSubmission`; a false compare-and-set
   *  throws so the whole append — draft transition AND submission row — rolls back. */
  consumeInTransaction(
    db: Database.Database,
    input: JournalSubmissionConsume & { consumedAs: string }
  ): void {
    const { db: own } = this.deps.database()
    if (own !== db) {
      // Same handle only: a second connection could not join the transaction.
      throw new AgentSessionJournalError('journal_closed', 'consume crossed database handles')
    }
    if (input.yieldsToPause) {
      // Judged again here, by the drain's own rule. Today a Stop cannot land between the drain's
      // pick and this claim (both run on the session's serialized lane, held across the send), so
      // this guards any pause-relevant row written off that lane from overtaking a held card.
      const cards = listQueuedMessages(db, this.deps.sessionId)
      const pauses = this.derivePauses(cards)
      if (nextSendableQueuedCard(pauses, cards)?.messageId !== input.messageId) {
        throw new QueuedMessageNotConsumableError(input.messageId, input.expect)
      }
    }
    const consumed = consumeQueuedMessageInTransaction(db, {
      ...input,
      sessionId: this.deps.sessionId,
      now: this.deps.now()
    })
    if (!consumed) {
      throw new QueuedMessageNotConsumableError(input.messageId, input.expect)
    }
    this.changeRevision++
  }

  /** A skipped live settlement the journal already decided (`queued-message-settlement.ts`). */
  settlementOwed(): boolean {
    return queuedMessageSettlementOwed(this.list(), this.deps.state().submissions)
  }

  /** Waiting drafts a skipped echo hook left unwithdrawn; reads every item, so only the drain
   *  step asks, right before a draft would send. */
  deliveredByEchoOwed(): boolean {
    return draftsDeliveredByAppliedEcho(this.deps.state(), this.list()).length > 0
  }

  /** Applies owed settlements now, so a skipped live transition heals without a reopen. */
  settleOwed(): Promise<void> {
    return this.transact(
      (db) =>
        settleOwedQueuedMessages(db, {
          sessionId: this.deps.sessionId,
          state: this.deps.state(),
          now: this.deps.now()
        }),
      (settled) => settled > 0
    ).then(() => undefined)
  }

  /** Bookkeeping at open: a failure is reported and retried at the next open,
   *  never allowed to fail opening the chat. */
  repairAndPruneAtOpen(): Promise<void> {
    return this.repairAndPrune().catch((error: unknown) => {
      console.warn('[journal-open] queued-message repair skipped:', {
        sessionId: this.deps.sessionId,
        error: error instanceof Error ? error.message : String(error)
      })
    })
  }

  /**
   * Open-time reconciliation, a re-derivation behind the stored fact: owed
   * settlements apply exactly as the live hook would have (covers consume →
   * crash → downgrade → upgrade, where the old build rejected the leftover with
   * no hook), then retention runs.
   */
  repairAndPrune(): Promise<void> {
    // No draft, no work, and no write.
    if (this.deps.readOnly() || this.list().length === 0) {
      return Promise.resolve()
    }
    const { sessionId } = this.deps
    return this.transact(
      (db) => {
        const [now, state] = [this.deps.now(), this.deps.state()]
        return (
          settleOwedQueuedMessages(db, { sessionId, state, now }) +
          pruneQueuedMessages(db, {
            sessionId,
            now,
            replayWindowMs: QUEUED_MESSAGE_REPLAY_WINDOW_MS,
            submissionVerdict: retainedSubmissionVerdict(state.submissions)
          })
        )
      },
      (changed) => changed > 0
    ).then(() => undefined)
  }
}
