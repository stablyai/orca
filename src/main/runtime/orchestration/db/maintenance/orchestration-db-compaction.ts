import { link } from 'node:fs/promises'
import { dirname } from 'node:path'
import Database from '../../../../sqlite/sync-database'
import type { OrchestrationDb } from '../orchestration-db'
import { refuseOrchestrationDbWritesForReplacement } from '../orchestration-db-file'
import { runCompactionChild, type CompactionChild } from './orchestration-db-compaction-child'
import { renameFileWithWindowsRetryAsync } from '../../../../../shared/file-write/windows-retry-file-operations'
import { syncDirectory } from '../../../../filesystem/durable-file-write'
import { settleWithinMs } from '../../../../startup/quit/quit-teardown-deadline'
import { availableBytesIn, removeQuietly, sizeOf } from './orchestration-db-compaction-files'
import {
  ATTEMPT_SPACING_MS,
  MAX_ATTEMPT_SPACING_MS,
  MAX_COPIES,
  MIN_COPY_BUDGET_MS,
  attemptSpacingMs,
  copyBudgetMs,
  readAttempts,
  writeAttempts
} from './orchestration-db-compaction-schedule'

const MIB = 1024 * 1024
// Maintenance minutes with no write before copying; a write after the copy makes it stale.
const QUIET_TICKS = 5
// Retention waits at most this long for a quit to use a ready copy, then prunes and the copy goes stale.
const MAX_PRUNE_DEFERRAL_MS = MAX_ATTEMPT_SPACING_MS
// journal_size_limit: closing at quit checkpoints at most this much.
const MAX_WAL_BYTES = 8 * MIB
const UNLINK_WAIT_MS = 1_000

export type OrchestrationDbSwap =
  | { kind: 'none' | 'stale' | 'busy' }
  | { kind: 'compacted'; beforeBytes: number; afterBytes: number; ms: number }
  | { kind: 'failed'; error: string }

// One cached statement on the runtime's connection, page 1 only.
const FILE_STATE_SQL = `SELECT a.auto_vacuum, p.page_size, c.page_count, f.freelist_count
  FROM pragma_auto_vacuum AS a, pragma_page_size AS p, pragma_page_count AS c, pragma_freelist_count AS f`

function readFileState(db: Database.Database): { legacy: boolean; liveBytes: number } {
  const row = db.prepare(FILE_STATE_SQL).get() ?? {}
  return {
    legacy: Number(row.auto_vacuum) === 0,
    liveBytes: (Number(row.page_count) - Number(row.freelist_count)) * Number(row.page_size)
  }
}

/**
 * Shrinks an orchestration database made before incremental auto-vacuum, which otherwise keeps its freed
 * pages forever. Once the file has gone a few maintenance minutes without a write, a child writes a
 * compacted copy with `VACUUM INTO`; a clean quit swaps it in if nothing was written since. The main
 * thread only reads counters and renames files, whatever the database's size.
 */
export class OrchestrationDbCompaction {
  private finished = false
  private swapping = false
  private stopped = false
  private started = false
  private lastActivity: string | null = null
  private quietTicks = 0
  // Copies this file has cost across sessions, and when the last one started.
  private attempts = 0
  // The copy started this session and not yet counted, as used or swapped.
  private uncounted = false
  private lastAttemptAt = Number.NEGATIVE_INFINITY
  // A full disk or a pinned WAL: retried hourly, without counting a copy.
  private heldAt = Number.NEGATIVE_INFINITY
  private copying: CompactionChild | undefined
  private running: Promise<boolean> | undefined
  private ready: { stamp: string; at: number } | undefined
  // Read-only, opened on the first legacy minute and kept until the swap: its data_version moves with every
  // commit to the file, the runtime's included, and nothing else (the runtime's TEMP tables write, for one).
  private observer: Database.Database | undefined

  constructor(
    private readonly orchestrationDb: OrchestrationDb,
    private readonly filename: string,
    private readonly isEnabled: () => boolean,
    private readonly quietTicksNeeded = QUIET_TICKS
  ) {
    // Before the runtime's connection closes: as the last one, it checkpoints and removes the WAL, which a
    // read-only observer left open would stop. Only the swap keeps the observer past it.
    orchestrationDb.onClose(() => {
      if (!this.swapping) {
        this.closeObserver()
      }
    })
  }

  private get copyPath(): string {
    return `${this.filename}-compacted`
  }

  /** The copy and the rollback journal VACUUM INTO keeps beside it while writing. */
  private async removeCopy(): Promise<void> {
    await Promise.all([removeQuietly(this.copyPath), removeQuietly(`${this.copyPath}-journal`)])
  }

  private get replacedPath(): string {
    return `${this.filename}-replaced`
  }

  /** `<copies> <start of the last, ms>`, across sessions. */
  private get attemptsPath(): string {
    return `${this.filename}-compaction-attempts`
  }

  /** Called once per maintenance minute. */
  async tick(): Promise<void> {
    if (this.finished || this.stopped || this.copying) {
      return
    }
    if (!this.started) {
      // From a session that quit or crashed part-way, or skipped its swap; cleared even where this is off.
      this.started = true
      await Promise.all([this.removeCopy(), removeQuietly(this.replacedPath)])
      const record = await readAttempts(this.attemptsPath)
      this.attempts = record.attempts
      this.lastAttemptAt = record.lastAttemptAt
    }
    // Stopped during the reads above, not compacting here, or every copy went stale before a quit used it.
    if (this.stopped || !this.isEnabled() || (this.attempts >= MAX_COPIES && !this.ready)) {
      return
    }
    const state = readFileState(this.orchestrationDb.db)
    if (!state.legacy) {
      this.finished = true
      this.closeObserver()
      await removeQuietly(this.attemptsPath)
      return
    }
    this.observer ??= new Database(this.filename, { readonly: true, fileMustExist: true })
    const activity = this.stamp()
    if (this.ready) {
      if (activity === this.ready.stamp) {
        return
      }
      this.ready = undefined
      await Promise.all([this.removeCopy(), this.countDiscarded()])
    }
    this.quietTicks = activity === this.lastActivity ? this.quietTicks + 1 : 0
    this.lastActivity = activity
    const now = Date.now()
    if (
      this.quietTicks < this.quietTicksNeeded ||
      now - this.lastAttemptAt < attemptSpacingMs(this.attempts) ||
      now - this.heldAt < ATTEMPT_SPACING_MS
    ) {
      return
    }
    // Room for the copy beside the file, with as much again to spare.
    if ((await availableBytesIn(dirname(this.filename))) < 2 * state.liveBytes) {
      this.heldAt = now
      return
    }
    if (this.stopped) {
      return
    }
    // Drained off main first, so a valid copy leaves quit's checkpoint on main nothing to copy. A drained WAL
    // keeps its size, which quit would read as pending work, so a large one is truncated too, though only
    // then: that takes the writer lock for a moment, and moves the stamp (a passive drain doesn't).
    const beforeDrain = this.stamp()
    const walBytes = (await sizeOf(`${this.filename}-wal`)) ?? 0
    const drained =
      walBytes === 0 ||
      (await this.runChild(undefined, MIN_COPY_BUDGET_MS, walBytes > MAX_WAL_BYTES))
    // Read before the child takes its snapshot, so any later commit moves the stamp.
    const stamp = this.stamp()
    const walAfter = (await sizeOf(`${this.filename}-wal`)) ?? 0
    // No copy in vain: a reader pinned frames, quit would refuse the WAL, or a commit since the drain left
    // frames for main to copy at quit (only a truncation, which empties the WAL, may move the stamp).
    const settled = walAfter === 0 || (walAfter <= MAX_WAL_BYTES && stamp === beforeDrain)
    if (!drained || !settled) {
      this.heldAt = now
      return
    }
    this.lastAttemptAt = now
    // Marked in flight before it starts, so a copy whose outcome is never recorded (a quit, a crash or a
    // failed write) still counts at the next launch: a failure errs toward fewer copies, never more.
    const kept = await writeAttempts(this.attemptsPath, this.attempts, now, true)
    // A commit during that write would stale the copy before its watch starts: no copy, so unmark it.
    if (!kept || this.stopped || this.stamp() !== stamp) {
      this.heldAt = now
      await (kept && writeAttempts(this.attemptsPath, this.attempts, now))
      return
    }
    this.uncounted = true
    const copied = await this.runChild(stamp, copyBudgetMs(state.liveBytes, this.attempts + 1))
    if (copied && !this.stopped && this.stamp() === stamp) {
      this.ready = { stamp, at: Date.now() }
    } else if (!this.stopped) {
      await Promise.all([this.removeCopy(), this.countDiscarded()])
    }
  }

  /** A copy went unused: it counts once toward the cap and the wait before the next one. */
  private async countDiscarded(): Promise<void> {
    if (this.uncounted) {
      this.uncounted = false
      this.attempts++
      await writeAttempts(this.attemptsPath, this.attempts, this.lastAttemptAt)
    }
  }

  /** Moves with any commit to the file, by any connection, since the observer opened. */
  private stamp(): string {
    return String(this.observer?.pragma('data_version', { simple: true }))
  }

  private closeObserver(): void {
    this.observer?.close()
    this.observer = undefined
  }

  private async dropCopy(): Promise<void> {
    this.ready = undefined
    this.closeObserver()
    await this.removeCopy()
  }

  /** With a stamp, writes the copy and stops once a commit moves it; without, only drains the WAL. */
  private async runChild(
    stamp: string | undefined,
    budgetMs: number,
    truncate = false
  ): Promise<boolean> {
    const run = runCompactionChild({
      filename: this.filename,
      target: stamp === undefined ? undefined : this.copyPath,
      truncate,
      budgetMs,
      isStale: () => {
        try {
          return this.stamp() !== stamp
        } catch {
          // A closed database: nothing left to copy for.
          return true
        }
      }
    })
    this.copying = run.child
    this.running = run.done
    try {
      return await run.done
    } finally {
      this.copying = undefined
      this.running = undefined
    }
  }

  /** At quit without a ready copy: stops one still being written and removes its output before returning. */
  async discardUnfinishedCopy(): Promise<void> {
    if (this.ready) {
      return
    }
    const running = this.running
    this.stop()
    await running
    await this.removeCopy()
  }

  /** Stops a copy in progress; a finished copy stays for the quit swap. */
  stop(): void {
    this.stopped = true
    if (this.copying) {
      this.copying.kill('SIGKILL')
    }
    if (!this.ready) {
      void this.dropCopy()
    }
  }

  get hasCopy(): boolean {
    return this.ready !== undefined
  }

  /** True while a ready copy is young enough that maintenance holds its prune, whose writes would stale it. */
  get defersPrune(): boolean {
    return this.ready !== undefined && Date.now() - this.ready.at < MAX_PRUNE_DEFERRAL_MS
  }

  /**
   * At the end of a clean quit: swaps the copy in when the file is unchanged since it was taken. `detach`
   * cuts the runtime off the database and resolves once its checkpoint thread is gone; the swap closes the
   * runtime's connection first, so a reference kept across an await fails rather than writing after the check.
   */
  async swapAtQuit(detach: () => Promise<void>): Promise<OrchestrationDbSwap> {
    // Kept set until the end: detaching stops maintenance, whose stop drops an unready copy.
    const ready = this.ready
    if (!ready) {
      return { kind: 'none' }
    }
    const started = performance.now()
    let lock: Database.Database | undefined
    const closeLock = (): void => {
      lock?.close()
      lock = undefined
    }
    const giveUp = async (kind: 'busy' | 'stale'): Promise<OrchestrationDbSwap> => {
      closeLock()
      await Promise.all([this.dropCopy(), this.countDiscarded()])
      return { kind }
    }
    try {
      const beforeBytes = await sizeOf(this.filename)
      const walBytes = await sizeOf(`${this.filename}-wal`)
      if (beforeBytes === null || (walBytes ?? 0) > MAX_WAL_BYTES) {
        return await giveUp('busy')
      }
      // From here on nothing else in this process can reach the file.
      refuseOrchestrationDbWritesForReplacement(this.filename)
      this.swapping = true
      const detached = detach()
      this.orchestrationDb.close()
      // No connection of this process but the observer is left, so the lock below needs no wait.
      await detached
      // Its data_version, read before the observer's last read, counts every commit after it.
      lock = new Database(this.filename, { fileMustExist: true })
      const others = Number(lock.pragma('data_version', { simple: true }))
      const observed = this.stamp()
      this.closeObserver()
      if (observed !== ready.stamp) {
        return await giveUp('stale')
      }
      try {
        // Refused at once while another connection that has read the file is open; once held, it keeps every
        // other reader and writer out. An external handle that never read holds no lock, so it isn't excluded
        // (see the PR's "Not covered"). The checkpoint leaves an empty WAL, so nothing of the old file can be
        // replayed onto the copy.
        lock.exec(
          'PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT; PRAGMA wal_checkpoint(TRUNCATE)'
        )
      } catch {
        return await giveUp('busy')
      }
      if (Number(lock.pragma('data_version', { simple: true })) !== others) {
        return await giveUp('stale')
      }
      // The second name keeps the old file's blocks alive, so the rename doesn't wait for them to be freed.
      const kept = await link(this.filename, this.replacedPath).then(
        () => true,
        () => false
      )
      // Elsewhere under the lock; Windows can't rename over an open file, and fails if it was reopened.
      if (process.platform === 'win32') {
        closeLock()
      }
      await renameFileWithWindowsRetryAsync(this.copyPath, this.filename)
      this.ready = undefined
      closeLock()
      // The old file's WAL (emptied above) and index: SQLite leaves them, since the path names the copy now.
      await Promise.all([
        removeQuietly(`${this.filename}-wal`),
        removeQuietly(`${this.filename}-shm`),
        removeQuietly(this.attemptsPath)
      ])
      await syncDirectory(dirname(this.filename))
      if (kept) {
        await settleWithinMs(removeQuietly(this.replacedPath), UNLINK_WAIT_MS)
      }
      return {
        kind: 'compacted',
        beforeBytes,
        afterBytes: (await sizeOf(this.filename)) ?? 0,
        ms: Math.round(performance.now() - started)
      }
    } catch (error) {
      closeLock()
      await Promise.all([this.dropCopy(), this.countDiscarded()])
      return { kind: 'failed', error: String(error) }
    }
  }
}
