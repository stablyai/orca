// Advance a lagging saved view one atomic page at a time from its durable coverage. Each committed
// page is a valid prefix to restart from, and sends never wait for the whole chat.

import { isDeepStrictEqual } from 'node:util'
import type { JournalHostDatabase } from './journal-host-database'
import { startJournalRowFold } from './journal-open'
import { createJournalReducerState, type JournalReducerState } from './journal-reducer'
import { isolateJournalTransition } from './journal-reducer-transition'
import { readJournalRowsWithin, readJournalSessionEpoch } from './journal-row-table'
import { clearJournalSavedState, writeJournalProjection } from './journal-projection-table'
import { JOURNAL_STATE_CODEC_VERSION } from './journal-state-codec'
import {
  logJournalProjectionFailure,
  readJournalSavedStamp,
  readJournalSavedStatePages,
  unrefJournalProjectionTimer,
  type JournalSavedStamp
} from './journal-saved-state'

const PAGE_ROWS = 32
// A page stops reading after the row whose text crosses about 1 MiB (UTF-16 units); one row
// always fits. Saved-view pages use the same budget.
const PAGE_CHARS = 1 << 20
const SLICE_MS = 25

export type JournalCatchUpStep =
  /** One page committed; coverage moved forward. */
  | 'advanced'
  /** No rows follow the saved coverage. */
  | 'current'
  /** The next page holds damage or rows from a newer build; nothing was written. */
  | 'parked'
  /** Another writer moved the saved view; the prefix reloads before the next page. */
  | 'stale'
  /** The chat no longer has this epoch. */
  | 'retired'
  /** The page did not commit; coverage is unchanged. */
  | 'failed'

/** Charges each synchronous unit of runner work; `rest` resolves false when the runner must stop. */
export type JournalCatchUpPacing = {
  work: <T>(unit: () => T) => T
  rest: () => Promise<boolean>
}

/** A private prefix of one epoch, never the live state; it changes only after its page commits. */
export class JournalProjectionCatchUp {
  private base: { state: JournalReducerState; stamp: JournalSavedStamp; valid: boolean } | null =
    null

  constructor(
    private readonly database: JournalHostDatabase,
    readonly sessionId: string,
    readonly epoch: string,
    /** Tests page single rows to check every prefix. */
    private readonly pageRows = PAGE_ROWS
  ) {}

  /** The private prefix's coverage, which the saved view holds after each committed page. */
  get through(): number {
    return this.base?.state.lastSequence ?? 0
  }

  /** Decodes the accepted prefix once, resting between pages. Storage errors throw: a view that
   * could not be read is never taken as missing. */
  async load(pacing: JournalCatchUpPacing): Promise<'ready' | 'stopped' | 'parked'> {
    if (this.base) {
      return 'ready'
    }
    const { database, sessionId, epoch } = this
    const budget = { rows: this.pageRows, chars: PAGE_CHARS }
    const pages = readJournalSavedStatePages(() => database.db, sessionId, epoch, budget)
    const stamp = pacing.work(() => readJournalSavedStamp(database.db, sessionId))
    let step = pacing.work(() => pages.next())
    while (!step.done) {
      if (!(await pacing.rest())) {
        return 'stopped'
      }
      step = pacing.work(() => pages.next())
    }
    const view = step.value
    // A present view this build cannot read may be the chat's only authority for its history; it is
    // replaced only after every row through the tip folds cleanly. R1's contract recognition joins
    // this classification and the stamp.
    if (view === 'unreadable') {
      const proof = await this.prove(pacing)
      if (proof !== 'ready') {
        return proof
      }
    }
    // An absent or other-epoch view, or a proven unreadable one, restarts from the epoch's first
    // row; that page clears it.
    this.base =
      typeof view === 'string'
        ? { state: createJournalReducerState(sessionId, epoch), stamp, valid: false }
        : { state: view, stamp, valid: true }
    return 'ready'
  }

  /** Runs synchronously on the chat's owning lane: one FULL transaction or nothing. */
  page(): JournalCatchUpStep {
    const { base, database, sessionId, epoch } = this
    if (!base) {
      return 'stale'
    }
    if (database.readOnly || database.isClosed) {
      return 'failed'
    }
    try {
      const outcome = database.transaction(
        (db): JournalCatchUpStep | (() => JournalReducerState) => {
          if (readJournalSessionEpoch(db, sessionId) !== epoch) {
            return 'retired'
          }
          // The exact predecessor: a delta folded from one saved view must never land on another.
          if (!isDeepStrictEqual(readJournalSavedStamp(db, sessionId), base.stamp)) {
            return 'stale'
          }
          const after = base.state.lastSequence
          const rows = readJournalRowsWithin(
            db,
            sessionId,
            epoch,
            after === 0 ? Number.MIN_SAFE_INTEGER : after,
            this.pageRows,
            PAGE_CHARS
          )
          if (rows.length === 0) {
            return 'current'
          }
          const transition = isolateJournalTransition(base.state, (draft) => {
            const fold = startJournalRowFold({ sessionId, epoch, untilDamage: true }, draft)
            for (const row of rows) {
              if (!fold.add(row)) {
                break
              }
            }
            return fold.finish()
          })
          // Coverage never crosses damage; earlier pages stay as the valid prefix.
          if (transition.result.damage || transition.result.newer) {
            return 'parked'
          }
          if (!base.valid) {
            clearJournalSavedState(db, sessionId)
          }
          writeJournalProjection(db, transition.state, transition.changes())
          return transition.adopt
        }
      )
      if (typeof outcome === 'string') {
        if (outcome === 'stale') {
          this.base = null
        }
        return outcome
      }
      const state = outcome()
      this.base = {
        state,
        stamp: { epoch, through: state.lastSequence, version: JOURNAL_STATE_CODEC_VERSION },
        valid: true
      }
      return 'advanced'
    } catch (error) {
      logJournalProjectionFailure(sessionId, error)
      return 'failed'
    }
  }

  /** Folds every row through the tip on a throwaway state, writing nothing. */
  private async prove(pacing: JournalCatchUpPacing): Promise<'ready' | 'stopped' | 'parked'> {
    const { database, sessionId, epoch } = this
    const fold = startJournalRowFold({ sessionId, epoch, untilDamage: true })
    let after = Number.MIN_SAFE_INTEGER
    for (;;) {
      const rows = pacing.work(() =>
        readJournalRowsWithin(database.db, sessionId, epoch, after, this.pageRows, PAGE_CHARS)
      )
      const last = rows.at(-1)
      if (!last) {
        break
      }
      if (!pacing.work(() => rows.every((row) => fold.add(row)))) {
        return 'parked'
      }
      after = last.seq
      if (!(await pacing.rest())) {
        return 'stopped'
      }
    }
    const proved = fold.finish()
    return proved.damage || proved.newer ? 'parked' : 'ready'
  }
}

/** Rests nine times the runner's own work once it reaches 25 ms; time spent awaiting other work
 * (an open chat's catch-up, the write lane, rests) is not charged. */
export function journalCatchUpPace(
  now: () => number = () => performance.now(),
  rest: (ms: number) => Promise<void> = (ms) =>
    new Promise<void>((resolve) => unrefJournalProjectionTimer(setTimeout(resolve, ms)))
): { work: <T>(unit: () => T) => T; rest: () => Promise<void> } {
  let worked = 0
  return {
    work<T>(unit: () => T): T {
      const start = now()
      try {
        return unit()
      } finally {
        worked += now() - start
      }
    },
    async rest(): Promise<void> {
      if (worked >= SLICE_MS) {
        const ms = worked * 9
        worked = 0
        await rest(ms)
      }
    }
  }
}
