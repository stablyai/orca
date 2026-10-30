import { isDeepStrictEqual } from 'node:util'
import type Database from '../../sqlite/sync-database'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import { prepareJournalOutcomeWrite } from './journal-outcome-write'
import { encodeJournalState } from './journal-state-codec'
import { restoreJournal } from './journal-open'
import { requestJournalMaintenance } from './journal-maintenance'
import { logJournalProjectionFailure } from './journal-saved-state'

// A full restore per check: development samples each chat so long streams stay responsive.
const DEVELOPMENT_VERIFY_INTERVAL_MS = 60_000

/** Writes outcomes with each append; a chat whose saved state lags (unconverted, or a cache behind
 * or failed) asks the database's maintenance runner, which owns all repair and its backoff. */
export class JournalWriteProjection {
  /** Projection tests check the equality invariant after every commit and throw on divergence. */
  static verifyEachCommit = false

  private verifiedAt = Number.NEGATIVE_INFINITY
  private closed = false

  constructor(
    private readonly deps: {
      database: JournalHostDatabase
      state: () => JournalReducerState
      adopt: (state: JournalReducerState) => void
    }
  ) {}

  opened(current: boolean): void {
    if (!current) {
      this.request()
    }
  }

  /** The callback is invoked only after the outer transaction has committed. */
  prepare(db: Database.Database, rows: readonly JournalRow[], savedAt: number): () => void {
    const transition = prepareJournalOutcomeWrite(db, this.deps.state(), rows, savedAt)
    return () => {
      this.deps.adopt(transition.adopt())
      if (!transition.current) {
        this.request()
      }
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
      logJournalProjectionFailure(this.deps.state().sessionId, error)
    }
  }

  close(): void {
    this.closed = true
  }

  /** Every saved form (input fold, cache, or outcome rebuild) must restore the live state. */
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

  private request(): void {
    if (!this.closed && !this.deps.database.isClosed) {
      requestJournalMaintenance(this.deps.database.db, this.deps.state().sessionId)
    }
  }
}
