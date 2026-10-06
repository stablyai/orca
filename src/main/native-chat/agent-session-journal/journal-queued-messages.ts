// The journal's draft-store collaborator: every read and write of one session's
// `queued_messages` rows, serialized on the same queue as the journal's own
// appends so a draft mutation can never interleave with the consume that
// converts it. Drafts are NEVER owed work: nothing here feeds the reducer,
// working status, teardown, or the idle sweep.

import type Database from '../../sqlite/sync-database'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import {
  AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS,
  AGENT_SESSION_OPERATION_FUTURE_SKEW_MS
} from '../../../shared/agent-session-host-authority'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import type { JournalOperationReceipt, JournalRowTransactionHook } from './journal-row-writer'
import type { JournalSubmissionConsume } from './journal-store-contracts'
import { adoptQueuedMessages, holdQueuedMessages } from './queued-message-holds'
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
import { pruneQueuedMessages, retainedSubmissionVerdict } from './queued-message-retention'
import {
  queuedMessageSettlementOwed,
  settleOwedQueuedMessages,
  settleQueuedMessagesForRow
} from './queued-message-settlement'
import { AgentSessionJournalError, assertJournalWritable } from './journal-write-guards'
import type { JournalWriteBody, JournalWriteResult } from './journal-write-queue'

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
  /** Whether this handle found the row at `sequence` on disk when it opened. */
  wroteBeforeOpen: (sequence: number) => boolean
  /** The journal's own commit notification. Every standalone draft-table
   *  transaction that changed rows fires it after COMMIT, so a draft or hold
   *  change publishes and wakes the drain through the same path a journal row
   *  does — no call site can forget. In-transaction consume and the returned
   *  transition already ride their row's own commit. */
  committed: () => void
}

export class JournalQueuedMessages {
  /** Bumped on every draft-table write, so publication memos recompute only when they must. */
  private changeRevision = 0
  private listed: { revision: number; rows: readonly QueuedMessageRow[] } | null = null

  constructor(private readonly deps: JournalQueuedMessagesDeps) {}

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

  /** `carriedFrom`: a /clear's carry. The card is its own 'cleared' pause, so it lands paused.
   *  `receipt`: the send's ledger answer, committed with the draft only when this inserts it. */
  insert(
    input: {
      messageId: string
      body: AgentJournalMessageItem
      fingerprint: string
      hostInstance: string
      carriedFrom?: string
    },
    receipt?: JournalOperationReceipt
  ): Promise<QueuedMessageRow> {
    const { sessionId } = this.deps
    let inserted = false
    return this.transact(
      (db) => {
        const existing = getQueuedMessage(db, sessionId, input.messageId)
        if (existing) {
          // One id, one draft: admission replays a recorded operation before it
          // gets here, so an existing row is the same accept landing twice.
          return existing
        }
        inserted = true
        const { epoch, lastSequence } = this.deps.state()
        const row = insertQueuedMessage(db, {
          ...input,
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
  pauses(hostInstance: string): DerivedQueuePause[] {
    return this.derivePauses(this.list(), hostInstance)
  }

  /** The person's Stop still pausing the queue, if any (`journalUserStopInForce`). */
  userStopInForce(): JournalQueuePauseMarks['latestStop'] {
    const state = this.deps.state()
    return journalUserStopInForce(state.queuePauseMarks, state.latestPersonTurnSequence)
  }

  private derivePauses(
    cards: readonly QueuedMessageRow[],
    hostInstance: string
  ): DerivedQueuePause[] {
    const state = this.deps.state()
    return deriveQueuePauses({
      epoch: state.epoch,
      marks: state.queuePauseMarks,
      latestPersonTurnSequence: state.latestPersonTurnSequence,
      cards,
      hostInstance,
      restartEnded: this.restartEnded()
    })
  }

  /** A person's turn started since this handle opened, which ends a restart's pause. */
  restartEnded(): boolean {
    const latest = this.deps.state().latestPersonTurnSequence
    return latest > 0 && !this.deps.wroteBeforeOpen(latest)
  }

  /** Adopts waiting rows another host instance wrote into this one, ending a restart's pause.
   *  Returns whether anything changed. */
  adopt(hostInstance: string): Promise<boolean> {
    const { sessionId } = this.deps
    return this.transact(
      (db) => adoptQueuedMessages(db, { sessionId, hostInstance }),
      (changed) => changed > 0
    ).then((changed) => changed > 0)
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

  /** One standalone draft-table transaction on the journal's queue; one that
   *  changed rows bumps the revision and notifies after COMMIT, `adopted` first. */
  private transact<T>(
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
      const pauses = this.derivePauses(cards, input.yieldsToPause.hostInstance)
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
    // No draft, no work, and no write: a chat whose first-use copy is still owed stays uncopied.
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

/** The per-append hook converting one draft inside the append's own transaction. */
export function queuedMessageConsumeHook(
  queuedMessages: JournalQueuedMessages,
  consumedAs: string,
  consume: JournalSubmissionConsume
): JournalRowTransactionHook {
  return (db) => queuedMessages.consumeInTransaction(db, { ...consume, consumedAs })
}

export class QueuedMessageNotConsumableError extends Error {
  constructor(
    readonly messageId: string,
    readonly expected: 'waiting' | 'returned'
  ) {
    super(`queued message ${messageId} is no longer ${expected}`)
    this.name = 'QueuedMessageNotConsumableError'
  }
}
