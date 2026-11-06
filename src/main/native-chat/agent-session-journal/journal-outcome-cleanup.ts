// One sweeper per database deletes retired epochs' records in the background. Opens and sends never
// wait for it: a retired generation is one no current epoch names, so no read reaches its records.

import type { JournalHostDatabase } from './journal-host-database'
import type Database from '../../sqlite/sync-database'

const FIRST_PASS_MS = 60_000
const PASS_INTERVAL_MS = 6 * 60 * 60_000
const sweepPositions = new WeakMap<Database.Database, number>()
type SweptDatabase = Pick<JournalHostDatabase, 'transaction' | 'isClosed' | 'readOnly'>

/** A retired epoch's records go with it, as main deletes a retired epoch's rows: every generation
 * the chat's current epoch no longer names is swept, one bounded page per transaction. */
export function sweepJournalOutcomePage(
  database: Pick<JournalHostDatabase, 'transaction'>
): boolean {
  return database.transaction((db) => {
    const after = sweepPositions.get(db) ?? 0
    const candidates = db
      .prepare(`SELECT a.generation FROM journal_outcome_generations a LEFT JOIN journal_outcome_epochs e
      ON e.session_id = a.session_id AND e.epoch = a.epoch AND e.generation = a.generation
      WHERE e.session_id IS NULL AND a.generation > ? ORDER BY a.generation LIMIT 32`)
      .all(after)
    for (const { generation } of candidates) {
      if (typeof generation !== 'number') {
        continue
      }
      sweepPositions.set(db, generation)
      const removed = db
        .prepare(`DELETE FROM journal_outcomes WHERE rowid IN (
        SELECT rowid FROM journal_outcomes WHERE generation = ? LIMIT 32)`)
        .run(generation)
      if (removed.changes === 0) {
        db.prepare('DELETE FROM journal_outcome_generations WHERE generation = ?').run(generation)
        continue
      }
      // One bounded data page per transaction, even with many retired generations. The next page
      // resumes at this generation, so it never rescans the live ones before it.
      sweepPositions.set(db, generation - 1)
      return true
    }
    if (candidates.length === 32) {
      return true
    }
    sweepPositions.delete(db)
    return false
  })
}

export type JournalPace = { work: <T>(unit: () => T) => T; rest: () => Promise<void> }

/** A 10% duty cycle for background deletion only: a chat open or a send is never charged. */
export function createJournalPace(
  now: () => number,
  delay: (ms: number) => Promise<void>
): JournalPace {
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
      const ms = worked >= 25 ? worked * 9 : 0
      if (ms > 0) {
        worked = 0
      }
      await delay(ms)
    }
  }
}

/** Sweeps a minute after launch, then every six hours; a failed pass is retried by the next one. */
export class JournalOutcomeSweeper {
  private readonly pace: JournalPace
  private running: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(
    private readonly deps: {
      database: () => SweptDatabase | null
      now?: () => number
      delay?: (ms: number) => Promise<void>
      onError?: (error: unknown) => void
    }
  ) {
    this.pace = createJournalPace(deps.now ?? (() => performance.now()), deps.delay ?? delay)
  }

  start(): this {
    this.schedule(FIRST_PASS_MS)
    return this
  }

  stop(): void {
    this.stopped = true
    this.clearTimer()
  }

  pass(): Promise<void> {
    this.running ??= this.run().finally(() => {
      this.running = null
      this.schedule(PASS_INTERVAL_MS)
    })
    return this.running
  }

  private async run(): Promise<void> {
    for (;;) {
      const database = this.current()
      if (!database || !this.pace.work(() => sweepJournalOutcomePage(database))) {
        return
      }
      await this.pace.rest()
    }
  }

  private schedule(ms: number): void {
    if (this.stopped) {
      return
    }
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      void this.pass().catch((error: unknown) => this.deps.onError?.(error))
    }, ms)
    unref(this.timer)
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = null
  }

  private current(): SweptDatabase | null {
    const database = this.deps.database()
    return this.stopped || !database || database.isClosed || database.readOnly ? null : database
  }
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => unref(setTimeout(resolve, ms)))
}

/** Mobile test programs type global timers as numbers; Node timers may release the event loop. */
function unref(timer: unknown): void {
  if (typeof timer === 'object' && timer && 'unref' in timer && typeof timer.unref === 'function') {
    timer.unref()
  }
}
