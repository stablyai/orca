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
import type { JournalSubmissionConsume } from './journal-store-contracts'
import { adoptQueuedMessages, holdQueuedMessages } from './queued-message-holds'
import {
  clearQueuePause,
  queuePauseHoldsBack,
  readQueuePause,
  recordQueuePause,
  retireQueuePauseIfNothingHeld,
  type QueuePauseFact,
  type QueuePauseReason
} from './queued-message-pause-table'
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
  owedBackToWaiting,
  queuedMessageSettlementOwed,
  settleOwedQueuedMessages,
  settleQueuedMessagesForRow
} from './queued-message-settlement'
import { AgentSessionJournalError, assertJournalWritable } from './journal-write-guards'

/** Tombstones must outlive the window in which their operation id could still be admitted as new. */
export const QUEUED_MESSAGE_REPLAY_WINDOW_MS =
  AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS + AGENT_SESSION_OPERATION_FUTURE_SKEW_MS

export type JournalQueuedMessagesDeps = {
  sessionId: string
  now: () => number
  serialize: <T>(run: () => Promise<T>) => Promise<T>
  database: () => JournalHostDatabase
  readOnly: () => boolean
  state: () => JournalReducerState
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
  private paused: { revision: number; fact: QueuePauseFact | null } | null = null

  constructor(private readonly deps: JournalQueuedMessagesDeps) {}

  revision(): number {
    return this.changeRevision
  }

  /** The submission row of the latest accepted turn a person asked for; 0 when none. What
   *  ends the queue's pause, read from the reducer in O(1). */
  latestPersonTurnSequence(): number {
    return this.deps.state().latestPersonTurnSequence
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

  /** `pausedBy`: the queue is paused in the SAME transaction as this card lands
   *  (a /clear's carry), so the drain never sees it unpaused and no pause fact
   *  exists without a card under it. */
  insert(input: {
    messageId: string
    body: AgentJournalMessageItem
    fingerprint: string
    hostInstance: string
    pausedBy?: QueuePauseReason
  }): Promise<QueuedMessageRow> {
    const { pausedBy, ...draft } = input
    const { sessionId } = this.deps
    let inserted = false
    return this.transact(
      (db) => {
        const existing = getQueuedMessage(db, sessionId, draft.messageId)
        if (existing) {
          // One id, one draft: admission replays a recorded operation before it
          // gets here, so an existing row is the same accept landing twice.
          return existing
        }
        inserted = true
        const row = insertQueuedMessage(db, { ...draft, sessionId, now: this.deps.now() })
        if (pausedBy) {
          recordQueuePause(db, { sessionId, fact: this.pauseFact(pausedBy) })
        }
        return row
      },
      () => inserted
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

  /** Where the user's last Stop took effect, if it is still recorded; cached per revision. */
  pause(): QueuePauseFact | null {
    if (this.paused?.revision !== this.changeRevision) {
      this.paused = {
        revision: this.changeRevision,
        fact: readQueuePause(this.deps.database().db, this.deps.sessionId)
      }
    }
    return this.paused.fact
  }

  /** A Stop took effect here: the queue is paused from this position on — if, judged in
   *  the same transaction, it holds back a card at all. Returns whether it recorded. */
  recordPause(reason: QueuePauseReason): Promise<boolean> {
    const fact = this.pauseFact(reason)
    return this.transact(
      (db) =>
        queuePauseHoldsBack(db, this.pauseScope()) &&
        (recordQueuePause(db, { sessionId: this.deps.sessionId, fact }), true),
      (recorded) => recorded
    )
  }

  /** What `queuePauseHoldsBack` judges a pause by, from this journal's submissions. */
  private pauseScope() {
    return {
      sessionId: this.deps.sessionId,
      owedToWaiting: owedBackToWaiting(this.deps.state().submissions)
    }
  }

  private pauseFact(reason: QueuePauseReason): QueuePauseFact {
    const { epoch, lastSequence: sequence } = this.deps.state()
    return { reason, epoch, sequence, recordedAt: this.deps.now() }
  }

  /** Ends the queue's pause: `stop` retires that Stop fact (never a later one),
   *  `adoptInto` adopts a restart's rows into this host instance. Returns whether
   *  anything changed. */
  liftPause(input: { stop: QueuePauseFact | null; adoptInto: string | null }): Promise<boolean> {
    const { sessionId } = this.deps
    return this.transact(
      (db) =>
        (input.stop ? clearQueuePause(db, { sessionId, fact: input.stop }) : 0) +
        (input.adoptInto === null
          ? 0
          : adoptQueuedMessages(db, { sessionId, hostInstance: input.adoptInto })),
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
   *  changed rows bumps the revision and notifies after COMMIT. */
  private transact<T>(
    run: (db: Database.Database) => T,
    changed: (result: T) => boolean
  ): Promise<T> {
    return this.deps.serialize(async () => {
      assertJournalWritable(this.deps.readOnly(), this.deps.sessionId)
      const { result, retired } = this.deps.database().transaction((db) => ({
        result: run(db),
        // Any draft write may take the last card a pause holds back.
        retired: retireQueuePauseIfNothingHeld(db, this.pauseScope())
      }))
      if (changed(result) || retired > 0) {
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
    this.changeRevision += retireQueuePauseIfNothingHeld(db, this.pauseScope())
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
    const consumed = consumeQueuedMessageInTransaction(db, {
      ...input,
      sessionId: this.deps.sessionId,
      now: this.deps.now()
    })
    if (!consumed) {
      throw new QueuedMessageNotConsumableError(input.messageId, input.expect)
    }
    retireQueuePauseIfNothingHeld(db, this.pauseScope())
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
   * no hook), then retention runs; a pause left holding back nothing retires.
   */
  repairAndPrune(): Promise<void> {
    // No draft, no work, and no write: a chat whose first-use copy is still owed stays uncopied.
    if (this.deps.readOnly() || (this.list().length === 0 && this.pause() === null)) {
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
): (db: Database.Database) => void {
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
