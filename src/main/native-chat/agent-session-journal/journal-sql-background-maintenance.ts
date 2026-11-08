import { setImmediate } from 'node:timers/promises'
import type { JournalSqlOwner } from './journal-sql-owner'
import type { JournalSqlReaderPool } from './journal-sql-reader-pool'
import type { JournalSqlConversions } from './journal-sql-conversions'
import type { JournalSqlActivity } from './journal-sql-activity'

/** Startup, requested sweeps and due work share one idle maintenance lane. */
export class JournalSqlBackgroundMaintenance {
  private readonly stopped = new AbortController()
  private running: Promise<void> | undefined
  private discover = false
  private sweep = false
  private due = false
  private deadline: { at: number; timer: NodeJS.Timeout } | undefined

  constructor(
    private readonly writer: Pick<JournalSqlOwner, 'maintain'>,
    private readonly readers: Pick<JournalSqlReaderPool, 'database'>,
    private readonly conversions: Pick<JournalSqlConversions, 'ensure'>,
    private readonly activity: JournalSqlActivity,
    private readonly onError: (error: unknown, sessionId?: string) => void
  ) {}

  start(): Promise<void> {
    this.discover = true
    this.due = true
    return this.requestSweep()
  }

  requestSweep(): Promise<void> {
    this.sweep = true
    return this.requestRun()
  }

  requestDueWork(at: number): void {
    if (this.stopped.signal.aborted || (this.deadline && this.deadline.at <= at)) {
      return
    }
    clearTimeout(this.deadline?.timer)
    const timer = setTimeout(
      () => {
        this.deadline = undefined
        this.due = true
        void this.requestRun()
      },
      Math.max(0, Math.min(at - Date.now(), 2_147_483_647))
    )
    timer.unref()
    this.deadline = { at, timer }
  }

  private requestRun(): Promise<void> {
    this.running ??= this.run().finally(() => {
      this.running = undefined
    })
    return this.running.then(() =>
      !this.stopped.signal.aborted && (this.discover || this.sweep || this.due)
        ? this.requestRun()
        : undefined
    )
  }

  stop(): void {
    this.stopped.abort()
    clearTimeout(this.deadline?.timer)
    this.deadline = undefined
  }

  settled(): Promise<void> {
    return this.running ?? Promise.resolve()
  }

  private async boundary(): Promise<boolean> {
    await this.activity.waitForIdle(this.stopped.signal)
    await setImmediate()
    return !this.stopped.signal.aborted
  }

  private async run(): Promise<void> {
    while (!this.stopped.signal.aborted && (this.discover || this.sweep || this.due)) {
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
          while (await this.boundary()) {
            if (!(await this.writer.maintain({ kind: 'projection-sweep' }))) {
              break
            }
          }
        } catch (error) {
          this.report(error)
        }
      }
      if (this.due) {
        this.due = false
        try {
          await this.pruneEventTail()
        } catch (error) {
          this.report(error)
          this.requestDueWork(Date.now() + 60_000)
        }
      }
    }
  }

  private async pruneEventTail(): Promise<void> {
    while (await this.boundary()) {
      const now = Date.now()
      const result = await this.writer.maintain({ kind: 'event-tail-prune', now })
      if (!result || typeof result !== 'object' || !('kind' in result)) {
        throw new Error('journal writer returned no event-tail result')
      }
      if (result.nextDueAt === null) {
        return
      }
      if (result.nextDueAt > now) {
        this.requestDueWork(result.nextDueAt)
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
