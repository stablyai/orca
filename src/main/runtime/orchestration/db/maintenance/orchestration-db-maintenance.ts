import { setImmediate, setTimeout as delay } from 'node:timers/promises'
import type { OrchestrationDb } from '../orchestration-db'
import { pruneSettledChatOutputCopies } from './settled-chat-output-copy-prune'

const MINUTE = 60_000
const PRUNE_INTERVAL_MS = 6 * 60 * MINUTE
// Bound each minute's reclaim, as the chat journal does.
const RECLAIM_PAGES_PER_PASS = 1024
const RECLAIM_PAGES_PER_STEP = 16

/** Prunes settled internal history every six hours and returns free pages, at a tenth of the thread. */
export class OrchestrationDbMaintenance {
  private readonly stopped = new AbortController()
  private timer: NodeJS.Timeout | undefined
  private work = 0

  constructor(
    private readonly orchestrationDb: OrchestrationDb,
    private readonly chatIsReadable: (dispatchId: string) => boolean
  ) {}

  start(): void {
    this.arm()
  }

  stop(): void {
    this.stopped.abort()
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private arm(): void {
    if (this.stopped.signal.aborted) {
      return
    }
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.pass()
        .catch((error) => {
          if (!this.stopped.signal.aborted) {
            console.warn('[orchestration] database maintenance failed', error)
          }
        })
        .finally(() => this.arm())
    }, MINUTE)
    this.timer.unref()
  }

  private async pass(): Promise<void> {
    if (this.pruneIsDue()) {
      const settledRuns = new Map<string, boolean>()
      for (let after: string | null = ''; after !== null;) {
        const page = await this.slice(() =>
          pruneSettledChatOutputCopies(
            this.orchestrationDb,
            after!,
            this.chatIsReadable,
            settledRuns
          )
        )
        if (!page) {
          return
        }
        after = page.next
      }
      // Persisted so a restart does not rescan before the interval.
      this.recordPrune()
    }
    // Only incremental files can return pages; others reuse them as they are freed.
    if (Number(this.orchestrationDb.db.pragma('auto_vacuum', { simple: true })) === 2) {
      for (let page = 0; page < RECLAIM_PAGES_PER_PASS; page += RECLAIM_PAGES_PER_STEP) {
        if (!(await this.slice(() => this.reclaimFreePages()))) {
          return
        }
      }
    }
  }

  private pruneIsDue(): boolean {
    const row = this.orchestrationDb.db
      .prepare('SELECT pruned_at FROM orchestration_maintenance WHERE id = 1')
      .get()
    return !row || Date.now() - Number(row.pruned_at) >= PRUNE_INTERVAL_MS
  }

  private recordPrune(): void {
    this.orchestrationDb.db
      .prepare(
        `INSERT INTO orchestration_maintenance (id, pruned_at) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET pruned_at = excluded.pruned_at`
      )
      .run(Date.now())
  }

  /** True while free pages remain. */
  private reclaimFreePages(): boolean {
    const free = Number(this.orchestrationDb.db.pragma('freelist_count', { simple: true }))
    if (free > 0) {
      this.orchestrationDb.db.exec(`PRAGMA incremental_vacuum(${RECLAIM_PAGES_PER_STEP})`)
    }
    return free > RECLAIM_PAGES_PER_STEP
  }

  /** Runs one bounded step, then rests nine times its work once 25 ms accumulates. */
  private async slice<T>(step: () => T): Promise<T | undefined> {
    await setImmediate()
    if (this.stopped.signal.aborted) {
      return undefined
    }
    const started = performance.now()
    const result = step()
    this.work += performance.now() - started
    if (this.work >= 25) {
      try {
        await delay(this.work * 9, undefined, { signal: this.stopped.signal, ref: false })
      } catch {
        return undefined
      }
      this.work = 0
    }
    return result
  }
}
