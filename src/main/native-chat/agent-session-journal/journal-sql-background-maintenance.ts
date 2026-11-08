import { setImmediate, setTimeout as delay } from 'node:timers/promises'
import type { JournalSqlOwner } from './journal-sql-owner'
import type { JournalSqlReaderPool } from './journal-sql-reader-pool'
import type { JournalSqlConversions } from './journal-sql-conversions'
import type { JournalSqlActivity } from './journal-sql-activity'
import type { JournalSqlMaintenance } from './journal-sql-maintenance'

const MINUTE = 60_000
const COMPACTION_INTERVAL = 6 * 60 * MINUTE

/** Conversion and retired epochs wait for idle; periodic pruning shares this owner without starvation. */
export class JournalSqlBackgroundMaintenance {
  private readonly stopped = new AbortController()
  private running: Promise<void> | undefined
  private discover = false
  private sweep = false
  private periodic = false
  private reclaim = 0
  private wake = new AbortController()
  private timer: NodeJS.Timeout | undefined

  constructor(
    private readonly writer: Pick<JournalSqlOwner, 'maintain'>,
    private readonly readers: Pick<JournalSqlReaderPool, 'database'>,
    private readonly conversions: Pick<JournalSqlConversions, 'ensure'>,
    private readonly activity: JournalSqlActivity,
    private readonly onError: (error: unknown, sessionId?: string) => void
  ) {}

  start(): Promise<void> {
    this.discover = true
    this.armPeriodic()
    return this.requestSweep()
  }

  requestSweep(): Promise<void> {
    this.sweep = true
    return this.requestRun()
  }

  private armPeriodic(): void {
    if (this.stopped.signal.aborted || this.timer) {
      return
    }
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.periodic = true
      this.reclaim = 1024
      this.wake.abort()
      this.wake = new AbortController()
      this.armPeriodic()
      void this.requestRun()
    }, MINUTE)
    this.timer.unref()
  }

  private requestRun(): Promise<void> {
    this.running ??= this.run().finally(() => {
      this.running = undefined
    })
    return this.running.then(() =>
      !this.stopped.signal.aborted && (this.discover || this.sweep || this.periodic)
        ? this.requestRun()
        : undefined
    )
  }

  stop(): void {
    this.stopped.abort()
    clearTimeout(this.timer)
    this.timer = undefined
  }

  settled(): Promise<void> {
    return this.running ?? Promise.resolve()
  }

  private async boundary(): Promise<boolean> {
    while (!this.stopped.signal.aborted) {
      await this.runOrdinaryWork()
      if (this.periodic) {
        continue
      }
      await this.activity.waitForIdle(AbortSignal.any([this.stopped.signal, this.wake.signal]))
      await setImmediate()
      if (!this.periodic) {
        return !this.stopped.signal.aborted
      }
    }
    return false
  }

  private async run(): Promise<void> {
    while (!this.stopped.signal.aborted && (this.discover || this.sweep || this.periodic)) {
      await this.runOrdinaryWork()
      if (this.discover) {
        this.discover = false
        try {
          await this.convertSavedChats()
        } catch (error) {
          this.report(error)
        }
      }
      if (this.sweep) {
        this.sweep = false
        try {
          await this.pages({ kind: 'domain-retired-prune' }, Infinity, true)
        } catch (error) {
          this.report(error)
        }
      }
    }
  }

  private async runOrdinaryWork(): Promise<void> {
    if (this.periodic && !this.stopped.signal.aborted) {
      this.periodic = false
      try {
        const state = await this.writer.maintain({ kind: 'compaction-state' })
        if (
          !state ||
          typeof state !== 'object' ||
          !('kind' in state) ||
          state.kind !== 'compaction-state'
        ) {
          throw new Error('journal writer returned no compaction state')
        }
        const now = Date.now()
        if (state.completedAt === null || now - state.completedAt >= COMPACTION_INTERVAL) {
          await this.pages({ kind: 'event-tail-prune', now })
          if (!this.stopped.signal.aborted) {
            await this.writer.maintain({ kind: 'compaction-complete', now: Date.now() })
            this.sweep = true
          }
        }
        await this.pages({ kind: 'page-reclaim' }, this.reclaim)
      } catch (error) {
        this.report(error)
      }
    }
  }

  private async pages(
    operation: Extract<
      JournalSqlMaintenance,
      { kind: 'event-tail-prune' | 'domain-retired-prune' | 'page-reclaim' }
    >,
    limit = Infinity,
    idle = false
  ): Promise<void> {
    let work = 0
    for (let unit = 0; unit < limit && !this.stopped.signal.aborted; unit++) {
      if (operation.kind !== 'page-reclaim' && this.reclaim > 0) {
        await this.pages({ kind: 'page-reclaim' }, 1)
      }
      if (idle && !(await this.boundary())) {
        return
      }
      await setImmediate()
      if (this.stopped.signal.aborted) {
        return
      }
      const started = performance.now()
      const result = await this.writer.maintain(operation)
      work += performance.now() - started
      if (!result || typeof result !== 'object' || !('more' in result)) {
        throw new Error('journal writer returned no maintenance page')
      }
      if (operation.kind === 'page-reclaim') {
        this.reclaim = result.more ? Math.max(0, this.reclaim - 1) : 0
      }
      if (work >= 25) {
        try {
          await delay(work * 9, undefined, { signal: this.stopped.signal, ref: false })
        } catch (error) {
          if (!this.stopped.signal.aborted) {
            throw error
          }
        }
        work = 0
      }
      if (!result.more) {
        return
      }
    }
  }

  private async convertSavedChats(): Promise<void> {
    let after: string | null = null
    while (await this.boundary()) {
      const page = await this.readers.database({ kind: 'sessions', after })
      if (page.kind !== 'sessions') {
        throw new Error('journal reader returned no saved sessions')
      }
      if (page.sessionIds.length === 0) {
        return
      }
      for (const sessionId of page.sessionIds) {
        if (!(await this.boundary())) {
          return
        }
        try {
          await this.conversions.ensure(sessionId, false)
        } catch (error) {
          this.report(error, sessionId)
        }
      }
      after = page.sessionIds.at(-1)!
    }
  }

  private report(error: unknown, sessionId?: string): void {
    if (!this.stopped.signal.aborted) {
      this.onError(error, sessionId)
    }
  }
}
