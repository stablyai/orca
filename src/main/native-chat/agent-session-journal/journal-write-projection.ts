import { isDeepStrictEqual } from 'node:util'
import type Database from '../../sqlite/sync-database'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import type { JournalWriteQueue } from './journal-write-queue'
import { prepareJournalOutcomeWrite } from './journal-outcome-write'
import { encodeJournalState } from './journal-state-codec'
import { restoreJournal } from './journal-open'
import {
  journalCatchUpPace,
  JournalProjectionCatchUp,
  type JournalCatchUpStep
} from './journal-projection-catch-up'
import { logJournalProjectionFailure, unrefJournalProjectionTimer } from './journal-saved-state'

// Each failed page or savepoint quadruples the wait, so a full disk is not retried on a short fixed
// timer; a committed page, a healthy incremental write or a reopen resets it.
const REPAIR_DELAY_MS = 1_000
const MAX_REPAIR_DELAY_MS = 60 * 60_000
// A full restore per check: development samples each chat so long streams stay responsive.
const DEVELOPMENT_VERIFY_INTERVAL_MS = 60_000

export class JournalWriteProjection {
  /** Projection tests check the equality invariant after every commit and throw on divergence. */
  static verifyEachCommit = false

  private through = 0
  private failures = 0
  private verifiedAt = Number.NEGATIVE_INFINITY
  private timer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private parked: string | null = null
  private catchUp: JournalProjectionCatchUp | null = null
  private catchingUp: Promise<void> | null = null

  constructor(
    private readonly deps: {
      database: JournalHostDatabase
      state: () => JournalReducerState
      adopt: (state: JournalReducerState) => void
      queue: JournalWriteQueue
    }
  ) {}

  opened(through: number): void {
    this.through = through
    this.failures = 0
    this.catchUp?.close()
    this.catchUp = null
    this.parked = null
    this.clearTimer()
    this.schedule()
  }

  /** The callback is invoked only after the outer transaction has committed. */
  prepare(db: Database.Database, rows: readonly JournalRow[], savedAt: number): () => void {
    const live = this.deps.state()
    const attempted = this.through === live.lastSequence && this.through > 0
    const transition = prepareJournalOutcomeWrite(db, live, rows, savedAt, attempted)
    const projected = transition.cached
    return () => {
      this.deps.adopt(transition.adopt())
      this.parked = null
      if (projected) {
        this.through = this.deps.state().lastSequence
        this.failures = 0
      } else if (attempted) {
        this.failures += 1
      }
      this.schedule()
    }
  }

  /** Timer and background requests join the one catch-up in flight. */
  repair = (): Promise<void> => {
    // A closing chat's next open repairs it.
    if (this.closed || this.parked === this.position()) {
      return Promise.resolve()
    }
    this.catchingUp ??= this.catchUpPages().finally(() => {
      this.catchingUp = null
      this.schedule()
    })
    return this.catchingUp
  }

  /** Sends keep committing between pages, skipping the projection until coverage meets the tip. */
  private async catchUpPages(): Promise<void> {
    const pace = journalCatchUpPace()
    const pacing = {
      work: pace.work,
      rest: async (): Promise<boolean> => {
        await pace.rest()
        return !this.closed
      }
    }
    try {
      for (;;) {
        const live = this.deps.state()
        if (this.closed) {
          return
        }
        // Coverage reached the tip: the private prefix is no longer needed, and later lag derives
        // a new one from durable coverage.
        if (this.through === live.lastSequence) {
          this.catchUp?.close()
          this.catchUp = null
          return
        }
        const catchUp =
          this.catchUp && this.catchUp.epoch === live.epoch
            ? this.catchUp
            : new JournalProjectionCatchUp(this.deps.database, live.sessionId, live.epoch)
        this.catchUp = catchUp
        const loaded = await catchUp.load(pacing)
        if (loaded === 'stopped') {
          catchUp.close()
          this.catchUp = null
          return
        }
        const step =
          loaded === 'parked'
            ? 'parked'
            : await this.deps.queue.serialize(() => pace.work(() => this.page(catchUp)))
        if (step === 'failed' || step === 'parked') {
          catchUp.close()
          this.catchUp = null
          if (step === 'parked') {
            this.parked = this.position()
          }
          this.failures += 1
          return
        }
        if (step === 'retired') {
          this.catchUp = null
          return
        }
        await pace.rest()
      }
    } catch (error) {
      this.catchUp?.close()
      this.catchUp = null
      if (!this.closed) {
        this.failures += 1
        logJournalProjectionFailure(this.deps.state().sessionId, error)
      }
    }
  }

  /** On the lane, so the next send sees whether coverage reached the tip. */
  private page(catchUp: JournalProjectionCatchUp): JournalCatchUpStep {
    if (this.closed || this.catchUp !== catchUp) {
      return 'stale'
    }
    const step = catchUp.page()
    if (step === 'advanced' || step === 'current') {
      this.through = catchUp.through
      this.failures = 0
    }
    return step
  }

  /** Tests: whether a private catch-up prefix is still held. */
  holdsCatchUp(): boolean {
    return this.catchUp !== null
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
    this.catchUp?.close()
    this.catchUp = null
    this.clearTimer()
  }

  private checkEquivalent(): void {
    const live = this.deps.state()
    const loaded = restoreJournal(this.deps.database.db, live.sessionId)
    if (
      !loaded ||
      loaded.projectionThrough !== this.through ||
      loaded.damage ||
      loaded.newer ||
      !isDeepStrictEqual(encodeJournalState(loaded.state), encodeJournalState(live))
    ) {
      throw new Error('journal outcome cache differs from live state')
    }
  }

  private position(): string {
    const state = this.deps.state()
    return `${state.epoch}\n${state.lastSequence}`
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = null
  }

  private schedule(): void {
    if (
      this.closed ||
      this.parked === this.position() ||
      this.timer ||
      this.catchingUp ||
      this.through === this.deps.state().lastSequence
    ) {
      return
    }
    const delay = Math.min(REPAIR_DELAY_MS * 4 ** this.failures, MAX_REPAIR_DELAY_MS)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.repair()
    }, delay)
    unrefJournalProjectionTimer(this.timer)
  }
}
