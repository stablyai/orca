import { isDeepStrictEqual } from 'node:util'
import type { JournalPersistencePlan } from './journal-persistence-plan'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import { prepareJournalOutcomeWriteAsync } from './journal-outcome-write'
import { encodeJournalState } from './journal-state-codec'
import { restoreJournalAsync } from './journal-open'
import { settleJournalCommit, type JournalOperationReceipt } from './journal-row-writer'
import { journalStoppedUsageLimitCut } from './journal-stopped-usage-limit-cut'
import type { UsageLimitContinueIdentity } from '../../../shared/agent-session/lifecycle/agent-session-usage-limit-continue'

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
      adopt: (state: JournalReducerState) => void
      withdrawStoppedCut?: (cut: UsageLimitContinueIdentity) => JournalOperationReceipt | undefined
    }
  ) {}

  /** The callback is invoked only after the outer transaction has committed. */
  async prepare(
    db: JournalPersistencePlan,
    rows: readonly JournalRow[],
    savedAt: number
  ): Promise<() => void> {
    const transition = await prepareJournalOutcomeWriteAsync(db, this.deps.state(), rows, savedAt)
    // A stopped cut and its withdrawal commit together, so no reader sees it schedulable.
    const cut = this.deps.withdrawStoppedCut && journalStoppedUsageLimitCut(transition.state, rows)
    const withdrawal = cut ? this.deps.withdrawStoppedCut?.(cut) : undefined
    await withdrawal?.write(db)
    return () => {
      settleJournalCommit(
        () => this.deps.adopt(transition.adopt()),
        () => withdrawal?.committed()
      )
    }
  }

  /** Runs after commit notification, never in the adopt path. */
  async verify(): Promise<void> {
    if (JournalWriteProjection.verifyEachCommit) {
      await this.checkEquivalent()
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
      await this.checkEquivalent()
    } catch (error) {
      logJournalVerifyFailure(this.deps.state().sessionId, error)
    }
  }

  /** Every saved form (input fold, prefix plus records, or records alone) must restore the live
   * state. */
  private async checkEquivalent(): Promise<void> {
    const lease = await this.deps.database.snapshot(() => {
      const live = this.deps.state()
      return { sessionId: live.sessionId, encoded: encodeJournalState(live) }
    })
    let loaded
    try {
      loaded = await restoreJournalAsync(lease.read, lease.view.sessionId)
    } finally {
      await lease.close()
    }
    if (
      !loaded ||
      loaded.damage ||
      loaded.newer ||
      !isDeepStrictEqual(encodeJournalState(loaded.state), lease.view.encoded)
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
