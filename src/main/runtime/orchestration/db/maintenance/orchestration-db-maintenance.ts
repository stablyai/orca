import { statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setImmediate, setTimeout as delay } from 'node:timers/promises'
import type Database from '../../../../sqlite/sync-database'
import type {
  OrchestrationDbReclaimRequest,
  OrchestrationDbStorage
} from '../../../../../shared/orchestration/orchestration-db-storage'
import { pruneSettledChatOutputCopies } from './settled-chat-output-copy-prune'

const MINUTE = 60_000
const PRUNE_INTERVAL_MS = 6 * 60 * MINUTE
// Bound each minute's reclaim, as the chat journal does.
const RECLAIM_PAGES_PER_PASS = 1024
const RECLAIM_PAGES_PER_STEP = 16

export function readOrchestrationDbStorage(db: Database.Database): OrchestrationDbStorage {
  const pageSize = Number(db.pragma('page_size', { simple: true }))
  return {
    databaseBytes: Number(db.pragma('page_count', { simple: true })) * pageSize,
    reclaimableBytes: Number(db.pragma('freelist_count', { simple: true })) * pageSize,
    shrinksItself: Number(db.pragma('auto_vacuum', { simple: true })) === 2
  }
}

/** Prunes settled internal history every six hours and returns free pages, at a tenth of the thread. */
export class OrchestrationDbMaintenance {
  private readonly stopped = new AbortController()
  private timer: NodeJS.Timeout | undefined
  private work = 0

  constructor(
    private readonly db: Database.Database,
    private readonly filename: string
  ) {}

  start(): void {
    this.arm()
  }

  stop(): void {
    this.stopped.abort()
    clearTimeout(this.timer)
    this.timer = undefined
  }

  storage(): OrchestrationDbStorage {
    return readOrchestrationDbStorage(this.db)
  }

  /** VACUUM copies the live pages to a temporary file, then writes them again to the WAL. */
  async reclaimRequest(): Promise<OrchestrationDbReclaimRequest> {
    const { databaseBytes, reclaimableBytes } = this.storage()
    const neededBytes = 2 * Math.ceil((databaseBytes - reclaimableBytes) * 1.1)
    const disk = await statfs(dirname(this.filename))
    const freeBytes = disk.bavail * disk.bsize
    return freeBytes < neededBytes ? { ok: false, neededBytes, freeBytes } : { ok: true }
  }

  /**
   * Blocks for as long as rewriting the whole file takes, so it runs only while Orca restarts:
   * done live, every write elsewhere would wait on it and fail after the busy timeout.
   */
  reclaimWhileRestarting(): void {
    this.stop()
    for (let after: string | null = ''; after !== null;) {
      after = pruneSettledChatOutputCopies(this.db, after).next
    }
    this.recordPrune()
    // Only VACUUM switches an existing file to incremental auto_vacuum.
    this.db.pragma('auto_vacuum = INCREMENTAL')
    this.db.exec('VACUUM')
    this.db.pragma('wal_checkpoint(TRUNCATE)')
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
      for (let after: string | null = ''; after !== null;) {
        const page = await this.slice(() => pruneSettledChatOutputCopies(this.db, after!))
        if (!page) {
          return
        }
        after = page.next
      }
      // Persisted so a restart does not rescan before the interval.
      this.recordPrune()
    }
    if (this.storage().shrinksItself) {
      for (let page = 0; page < RECLAIM_PAGES_PER_PASS; page += RECLAIM_PAGES_PER_STEP) {
        if (!(await this.slice(() => this.reclaimFreePages()))) {
          return
        }
      }
    }
  }

  private pruneIsDue(): boolean {
    const row = this.db
      .prepare('SELECT pruned_at FROM orchestration_maintenance WHERE id = 1')
      .get()
    return !row || Date.now() - Number(row.pruned_at) >= PRUNE_INTERVAL_MS
  }

  private recordPrune(): void {
    this.db
      .prepare(
        `INSERT INTO orchestration_maintenance (id, pruned_at) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET pruned_at = excluded.pruned_at`
      )
      .run(Date.now())
  }

  /** True while free pages remain. */
  private reclaimFreePages(): boolean {
    const free = Number(this.db.pragma('freelist_count', { simple: true }))
    if (free > 0) {
      this.db.exec(`PRAGMA incremental_vacuum(${RECLAIM_PAGES_PER_STEP})`)
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
