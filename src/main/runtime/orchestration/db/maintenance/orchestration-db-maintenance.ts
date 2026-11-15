import { access, constants, stat, statfs } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import { setImmediate, setTimeout as delay } from 'node:timers/promises'
import type { OrchestrationDb } from '../orchestration-db'
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

export function readOrchestrationDbStorage({ db }: OrchestrationDb): OrchestrationDbStorage {
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
    private readonly orchestrationDb: OrchestrationDb,
    private readonly filename: string,
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

  storage(): OrchestrationDbStorage {
    const row = this.orchestrationDb.db
      .prepare('SELECT reclaim_failed FROM orchestration_maintenance WHERE id = 1')
      .get()
    return {
      ...readOrchestrationDbStorage(this.orchestrationDb),
      lastReclaimFailed: Boolean(row?.reclaim_failed)
    }
  }

  /** VACUUM copies the live pages to a temporary file, then writes them again to the WAL. */
  async reclaimRequest(): Promise<OrchestrationDbReclaimRequest> {
    const { databaseBytes, reclaimableBytes } = this.storage()
    const copyBytes = Math.ceil((databaseBytes - reclaimableBytes) * 1.1)
    const [databaseDir, tempDir] = [dirname(this.filename), await sqliteTempDirectory()]
    const [databaseFree, tempFree, databaseDevice, tempDevice] = await Promise.all([
      freeBytes(databaseDir),
      freeBytes(tempDir),
      stat(databaseDir).then((info) => info.dev),
      stat(tempDir).then((info) => info.dev)
    ])
    const shortfall =
      databaseDevice === tempDevice
        ? databaseFree < 2 * copyBytes && { neededBytes: 2 * copyBytes, freeBytes: databaseFree }
        : (databaseFree < copyBytes && { neededBytes: copyBytes, freeBytes: databaseFree }) ||
          (tempFree < copyBytes && { neededBytes: copyBytes, freeBytes: tempFree })
    return shortfall ? { ok: false, ...shortfall } : { ok: true }
  }

  /**
   * Blocks for as long as rewriting the whole file takes, so it runs only while Orca restarts:
   * done live, every write elsewhere would wait on it and fail after the busy timeout.
   */
  reclaimWhileRestarting(): void {
    this.stop()
    try {
      for (let after: string | null = ''; after !== null;) {
        after = pruneSettledChatOutputCopies(this.orchestrationDb, after, this.chatIsReadable).next
      }
      this.recordPrune()
      // The copy VACUUM builds is the size of the live data; keep it on disk, not in memory.
      this.orchestrationDb.db.pragma('temp_store = FILE')
      // Only VACUUM switches an existing file to incremental auto_vacuum.
      this.orchestrationDb.db.pragma('auto_vacuum = INCREMENTAL')
      this.orchestrationDb.db.exec('VACUUM')
      this.orchestrationDb.db.pragma('wal_checkpoint(TRUNCATE)')
      this.recordReclaim(false)
    } catch (error) {
      // VACUUM rolls back whole; Settings says so after the restart.
      try {
        this.recordReclaim(true)
      } catch {
        // A full disk can refuse this write too; the VACUUM error is the one to report.
      }
      throw error
    }
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
        const page = await this.slice(() =>
          pruneSettledChatOutputCopies(this.orchestrationDb, after!, this.chatIsReadable)
        )
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

  private recordReclaim(failed: boolean): void {
    this.orchestrationDb.db
      .prepare(
        `INSERT INTO orchestration_maintenance (id, reclaim_failed) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET reclaim_failed = excluded.reclaim_failed`
      )
      .run(failed ? 1 : 0)
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

async function freeBytes(directory: string): Promise<number> {
  const disk = await statfs(directory)
  return disk.bavail * disk.bsize
}

// SQLite's search order for its temporary files (unixTempFileDir in os_unix.c); Windows uses the user temp folder.
async function sqliteTempDirectory(): Promise<string> {
  if (process.platform === 'win32') {
    return tmpdir()
  }
  const { SQLITE_TMPDIR, TMPDIR } = process.env
  for (const directory of [SQLITE_TMPDIR, TMPDIR, '/var/tmp', '/usr/tmp', '/tmp']) {
    if (!directory) {
      continue
    }
    try {
      if ((await stat(directory)).isDirectory()) {
        await access(directory, constants.W_OK | constants.X_OK)
        return directory
      }
    } catch {
      // SQLite skips folders it cannot write to and search.
    }
  }
  return '.'
}
