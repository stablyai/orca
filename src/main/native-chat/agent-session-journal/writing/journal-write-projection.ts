import { isDeepStrictEqual } from 'node:util'
import type { JournalHostDatabase } from '../database/journal-host-database'
import type { JournalReducerState } from '../projection/journal-reducer'
import type { JournalRow } from '../durable-rows/journal-row-schema'
import { prepareJournalOutcomeWrite } from '../outcomes/journal-outcome-write'
import { encodeJournalState } from '../outcomes/journal-state-codec'
import { restoreJournal } from '../replay/journal-open'
import type Database from '../../../sqlite/sync-database'
import type { JournalOperationReceipt } from './journal-row-writer'
import type { JournalCommittedRowsCapture } from '../journal-store-contracts'
import { journalStoppedUsageLimitCut } from '../context-epochs/journal-stopped-usage-limit-cut'
import type { UsageLimitContinueIdentity } from '../../../../shared/agent-session/lifecycle/agent-session-usage-limit-continue'

// A full restore per check: development samples each chat so long streams stay responsive.
const DEVELOPMENT_VERIFY_INTERVAL_MS = 60_000

/** Writes outcome records with each append and adopts their transition once the write commits. */
export class JournalWriteProjection {
  /** Projection tests check the equality invariant after every commit and throw on divergence. */
  static verifyEachCommit = false

  private verifiedAt = Number.NEGATIVE_INFINITY

  constructor(
    private readonly deps: {
      database: JournalHostDatabase
      state: () => JournalReducerState
      convertingLegacyQueue?: () => boolean
      adopt: (state: JournalReducerState) => void
      withdrawStoppedCut?: (cut: UsageLimitContinueIdentity) => JournalOperationReceipt | undefined
      captureCommittedRows?: JournalCommittedRowsCapture
    }
  ) {}

  /** The callback is invoked only after the outer transaction has committed. */
  prepare(
    db: Database.Database,
    rows: readonly JournalRow[],
    savedAt: number,
    finishFold?: (draft: JournalReducerState) => void
  ): () => void {
    const before = this.deps.state()
    const transition = prepareJournalOutcomeWrite(
      db,
      before,
      rows,
      savedAt,
      finishFold,
      this.deps.convertingLegacyQueue?.()
    )
    this.deps.captureCommittedRows?.(
      db,
      before.sessionId,
      rows,
      savedAt,
      (itemId) => before.items.get(itemId)?.body
    )
    // A stopped cut and its withdrawal commit together, so no reader sees it schedulable.
    const cut = this.deps.withdrawStoppedCut && journalStoppedUsageLimitCut(transition.state, rows)
    const withdrawal = cut ? this.deps.withdrawStoppedCut?.(cut) : undefined
    withdrawal?.write(db)
    return () => {
      withdrawal?.committed()
      this.deps.adopt(transition.adopt())
    }
  }

  /** Runs after commit notification, never in the adopt path. */
  verify(): void {
    if (JournalWriteProjection.verifyEachCommit) {
      this.checkEquivalent()
      return
    }
    const now = performance.now()
    if (
      process.env.NODE_ENV !== 'development' ||
      now - this.verifiedAt < DEVELOPMENT_VERIFY_INTERVAL_MS
    ) {
      return
    }
    this.verifiedAt = now
    try {
      this.checkEquivalent()
    } catch (error) {
      logJournalVerifyFailure(this.deps.state().sessionId, error)
    }
  }

  /** Every saved form (input fold, prefix plus records, or records alone) must restore the live
   * state. */
  private checkEquivalent(): void {
    const live = this.deps.state()
    const loaded = restoreJournal(this.deps.database.db, live.sessionId)
    if (
      !loaded ||
      loaded.damage ||
      loaded.newer ||
      !isDeepStrictEqual(encodeJournalState(loaded.state), encodeJournalState(live))
    ) {
      throw new Error('journal saved state differs from live state')
    }
  }
}

function logJournalVerifyFailure(sessionId: string, error: unknown): void {
  try {
    console.warn('[agent-session-journal] saved chat differs from live chat', { sessionId, error })
  } catch {
    // Diagnostics never turn a development check into a rejected send.
  }
}
