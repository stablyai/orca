import { setImmediate } from 'node:timers/promises'
import type { JournalSqlOwner } from './journal-sql-owner'
import type { JournalSqlReaderPool } from './journal-sql-reader-pool'
import type { JournalSqlConversions } from './journal-sql-conversions'
import type { JournalSqlActivity } from './journal-sql-activity'

/** One startup walk, then event-requested retired-epoch sweeps; no timer revisits converted chats. */
export class JournalSqlBackgroundMaintenance {
  private readonly stopped = new AbortController()
  private running: Promise<void> | undefined
  private discover = false
  private sweep = false

  constructor(
    private readonly writer: JournalSqlOwner,
    private readonly readers: JournalSqlReaderPool,
    private readonly conversions: JournalSqlConversions,
    private readonly activity: JournalSqlActivity,
    private readonly onError: (error: unknown, sessionId?: string) => void
  ) {}

  start(): Promise<void> {
    this.discover = true
    return this.requestSweep()
  }

  requestSweep(): Promise<void> {
    this.sweep = true
    this.running ??= this.run().finally(() => {
      this.running = undefined
    })
    return this.running.then(() =>
      !this.stopped.signal.aborted && (this.discover || this.sweep)
        ? this.requestSweep()
        : undefined
    )
  }

  stop(): void {
    this.stopped.abort()
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
    while (!this.stopped.signal.aborted && (this.discover || this.sweep)) {
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
