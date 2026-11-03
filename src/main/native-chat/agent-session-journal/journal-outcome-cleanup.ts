import { journalMaintenancePage } from './journal-maintenance-unit'
// One sweeper per database deletes retired epochs' records in the background. Opens and sends never
// wait for it: a retired generation is one no current epoch names, so no read reaches its records.

import type { JournalHostDatabase } from './journal-host-database'
import { JournalOutcomeCompaction } from './journal-outcome-compaction'
import { vacuumJournalPage } from './journal-incremental-vacuum'

const FIRST_PASS_MS = 60_000
const PASS_INTERVAL_MS = 6 * 60 * 60_000
const sweepPositions = new WeakMap<object, { after: number; upper: number }>()
type SweptDatabase = Pick<JournalHostDatabase, 'scan' | 'maintenance' | 'isClosed' | 'readOnly'>

/** A scan proposes stored identities; only the sole native writer can authorize their deletion. */
export async function sweepJournalOutcomePage(
  database: Pick<JournalHostDatabase, 'scan' | 'maintenance'>,
  charge: (ms: number) => void = () => {}
): Promise<boolean> {
  const discovered = await database.scan(async (read) => {
    const started = performance.now()
    try {
      const position = sweepPositions.get(database) ?? {
        after: 0,
        upper: Number(
          (
            await read
              .prepare('SELECT MAX(generation) AS generation FROM journal_outcome_generations')
              .get()
          )?.generation ?? 0
        )
      }
      const candidate = await read
        .prepare(`SELECT a.generation FROM journal_outcome_generations a LEFT JOIN journal_outcome_epochs e
        ON e.session_id = a.session_id AND e.epoch = a.epoch AND e.generation = a.generation
        WHERE e.session_id IS NULL AND a.generation > ? AND a.generation <= ? ORDER BY a.generation LIMIT 1`)
        .get(position.after, position.upper)
      if (typeof candidate?.generation !== 'number') {
        return { position, generation: null, rows: [] }
      }
      const found = await read
        .prepare(
          `SELECT rowid, length(CAST(value_json AS BLOB)) AS bytes FROM journal_outcomes WHERE generation = ? ORDER BY rowid LIMIT 32`
        )
        .all(candidate.generation)
      const rows = journalMaintenancePage(
        found.flatMap((row) =>
          typeof row.rowid === 'number' && typeof row.bytes === 'number'
            ? [{ rowid: row.rowid, bytes: row.bytes }]
            : []
        )
      )
      return { position, generation: candidate.generation, rows }
    } finally {
      charge(performance.now() - started)
    }
  })
  if (discovered.generation === null) {
    sweepPositions.delete(database)
    return false
  }
  const result = await database.maintenance({
    kind: 'retired',
    generation: discovered.generation,
    rows: discovered.rows
  })
  charge(result.elapsed)
  sweepPositions.set(database, {
    ...discovered.position,
    after: result.valid && result.more ? discovered.generation - 1 : discovered.generation
  })
  return true
}

export type JournalPace = {
  charge: (ms: number) => void
  work: <T>(unit: () => T) => T
  rest: () => Promise<void>
}

/** A 10% duty cycle for background deletion only: a chat open or a send is never charged. */
export function createJournalPace(
  now: () => number,
  delay: (ms: number) => Promise<void>
): JournalPace {
  let worked = 0
  return {
    charge: (ms) => {
      worked += ms
    },
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
  private readonly compaction = new JournalOutcomeCompaction()
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
    for (const page of [
      (database: SweptDatabase) => sweepJournalOutcomePage(database, this.pace.charge),
      (database: SweptDatabase) => this.compaction.page(database, this.pace.charge),
      (database: SweptDatabase) => vacuumJournalPage(database, this.pace.charge)
    ]) {
      for (;;) {
        const database = this.current()
        if (!database) {
          return
        }
        const more = await page(database)
        await this.pace.rest()
        if (!more) {
          break
        }
      }
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
