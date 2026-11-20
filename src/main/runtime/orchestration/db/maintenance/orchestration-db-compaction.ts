import type { ChildProcess } from 'node:child_process'
import { watch, type FSWatcher } from 'node:fs'
import { link, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { spawnProcess } from '@orca/process-host'
import Database from '../../../../sqlite/sync-database'
import type { OrchestrationDb } from '../orchestration-db'
import { refuseOrchestrationDbWritesForReplacement } from '../orchestration-db-file'
import { compactionChildSource } from './orchestration-db-compaction-child-source'
import {
  availableBytesIn,
  removeQuietly,
  settlesWithin,
  sizeOf,
  syncDirectory
} from './orchestration-db-compaction-files'

const MIB = 1024 * 1024
const MIN_FREE_BYTES = 32 * MIB
const MIN_FREE_FRACTION = 0.25
// Maintenance minutes with no write before copying; a write after the copy makes it stale.
const QUIET_TICKS = 5
// Each copy rewrites the live data, so a file whose copies keep going stale stops after a few, for good.
const ATTEMPTS_PER_SESSION = 3
const ATTEMPTS_PER_FILE = 6
const ATTEMPT_SPACING_MS = 60 * 60_000
// The copy blocks no one; this only bounds the disk and CPU it uses.
const COPY_BUDGET_MS = 120_000
// journal_size_limit: closing at quit checkpoints at most this much.
const MAX_WAL_BYTES = 8 * MIB
const LOCK_WAIT_MS = 300
const UNLINK_WAIT_MS = 1_000

export type OrchestrationDbSwap =
  | { kind: 'none' | 'stale' | 'busy' }
  | { kind: 'compacted'; beforeBytes: number; afterBytes: number; ms: number }
  | { kind: 'failed'; error: string }

// One cached statement on the runtime's connection, page 1 only: data_version moves with any other
// connection's commit.
const FILE_STATE_SQL = `SELECT d.data_version, a.auto_vacuum, p.page_size, c.page_count, f.freelist_count
  FROM pragma_data_version AS d, pragma_auto_vacuum AS a, pragma_page_size AS p,
    pragma_page_count AS c, pragma_freelist_count AS f`

type FileState = {
  othersVersion: number
  legacy: boolean
  /** Live bytes when enough pages are free to be worth a copy. */
  worthCopyingLiveBytes: number | null
}

function readFileState(db: Database.Database): FileState {
  const row = db.prepare(FILE_STATE_SQL).get() ?? {}
  const pageSize = Number(row.page_size)
  const pages = Number(row.page_count)
  const freePages = Number(row.freelist_count)
  const warranted = freePages * pageSize >= MIN_FREE_BYTES && freePages >= pages * MIN_FREE_FRACTION
  return {
    othersVersion: Number(row.data_version),
    legacy: Number(row.auto_vacuum) === 0,
    worthCopyingLiveBytes: warranted ? (pages - freePages) * pageSize : null
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
  private stopped = false
  private leftoversRemoved = false
  private lastActivity: string | null = null
  private quietTicks = 0
  private attempts = 0
  private pastAttempts = 0
  private lastAttemptAt = Number.NEGATIVE_INFINITY
  private copying: ChildProcess | undefined
  private ready: { stamp: string } | undefined
  // Opened before a copy and kept until the swap: its data_version moves with every commit to the file,
  // the runtime's included, and nothing else (the runtime's TEMP tables write at quit, for one).
  private observer: Database.Database | undefined

  constructor(
    private readonly orchestrationDb: OrchestrationDb,
    private readonly filename: string,
    private readonly isEnabled: () => boolean,
    private readonly quietTicksNeeded = QUIET_TICKS
  ) {}

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

  /** How many copies this file has cost across sessions. */
  private get attemptsPath(): string {
    return `${this.filename}-compaction-attempts`
  }

  /** Called once per maintenance minute. */
  async tick(): Promise<void> {
    if (this.finished || this.stopped || this.copying || !this.isEnabled()) {
      return
    }
    if (!this.leftoversRemoved) {
      // From a session that quit or crashed part-way, a swapped file included.
      this.leftoversRemoved = true
      await Promise.all([this.removeCopy(), removeQuietly(this.replacedPath)])
      this.pastAttempts = Number(await readFile(this.attemptsPath, 'utf8').catch(() => '0')) || 0
    }
    const { db } = this.orchestrationDb
    const state = readFileState(db)
    if (!state.legacy) {
      this.finished = true
      await removeQuietly(this.attemptsPath)
      return
    }
    if (this.ready) {
      if (this.stamp() === this.ready.stamp) {
        return
      }
      await this.dropCopy()
    }
    // Every commit, by any connection, writes the WAL.
    const wal = await stat(`${this.filename}-wal`).catch(() => null)
    const activity = `${state.othersVersion}:${wal?.size}:${wal?.mtimeMs}`
    this.quietTicks = activity === this.lastActivity ? this.quietTicks + 1 : 0
    this.lastActivity = activity
    if (this.pastAttempts + this.attempts >= ATTEMPTS_PER_FILE) {
      this.finished = true
      return
    }
    if (
      this.quietTicks < this.quietTicksNeeded ||
      this.attempts >= ATTEMPTS_PER_SESSION ||
      Date.now() - this.lastAttemptAt < ATTEMPT_SPACING_MS
    ) {
      return
    }
    const liveBytes = state.worthCopyingLiveBytes
    if (liveBytes === null) {
      return
    }
    // Room for the copy beside the file, with as much again to spare.
    if ((await availableBytesIn(dirname(this.filename))) < 2 * liveBytes) {
      return
    }
    if (this.stopped) {
      return
    }
    this.attempts++
    this.lastAttemptAt = Date.now()
    // Counted before it starts, so a quit or crash mid-copy still counts.
    const counted = await writeFile(
      this.attemptsPath,
      String(this.pastAttempts + this.attempts)
    ).then(
      () => true,
      () => false
    )
    if (!counted || this.stopped) {
      return
    }
    // Before the child takes its snapshot, so any later commit moves the stamp.
    this.observer = new Database(this.filename, { readonly: true, fileMustExist: true })
    const stamp = this.stamp()
    const copied = await this.copy(stamp)
    if (copied && !this.stopped && this.stamp() === stamp) {
      this.ready = { stamp }
    } else if (!this.stopped) {
      await this.dropCopy()
    }
  }

  /** Moves with any commit to the file, by any connection, since the observer opened. */
  private stamp(): string {
    return String(this.observer?.pragma('data_version', { simple: true }))
  }

  private async dropCopy(): Promise<void> {
    this.ready = undefined
    this.observer?.close()
    this.observer = undefined
    await this.removeCopy()
  }

  private copy(stamp: string): Promise<boolean> {
    return new Promise((resolve) => {
      let child: ChildProcess
      try {
        child = spawnProcess({
          program: process.execPath,
          args: ['-e', compactionChildSource],
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            ORCA_ORCHESTRATION_COMPACTION: JSON.stringify({
              filename: this.filename,
              target: this.copyPath,
              budgetMs: COPY_BUDGET_MS
            })
          },
          // Never written: the child stops itself when this end closes, so it can't outlive a killed app.
          stdio: ['pipe', 'ignore', 'ignore']
        })
      } catch {
        resolve(false)
        return
      }
      this.copying = child
      const budget = setTimeout(() => child.kill('SIGKILL'), COPY_BUDGET_MS)
      // A write makes the copy stale, so stop it then: its disk traffic can slow the runtime's later
      // commits (seen on a busy Linux disk). Every commit touches the WAL; the stamp stays the judge.
      let walWatch: FSWatcher | undefined
      try {
        walWatch = watch(`${this.filename}-wal`, () => {
          let stale = true
          try {
            stale = this.stamp() !== stamp
          } catch {
            // A closed database: nothing left to copy for.
          }
          if (stale) {
            child.kill('SIGKILL')
          }
        })
        walWatch.on('error', () => walWatch?.close())
      } catch {
        // No events on this file system: the check after the copy still drops a stale one.
      }
      // Any exit, update installs included: a child left running would hold the app's executable open.
      const killOnExit = (): void => {
        child.kill('SIGKILL')
      }
      process.once('exit', killOnExit)
      const done = (copied: boolean): void => {
        clearTimeout(budget)
        walWatch?.close()
        process.off('exit', killOnExit)
        this.copying = undefined
        resolve(copied)
      }
      child.once('error', () => done(false))
      child.once('close', (code) => done(code === 0))
    })
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

  /**
   * At the end of a clean quit: swaps the copy in when the file is unchanged since it was taken. `detach`
   * cuts the runtime off the database; the swap then closes the runtime's connection, so a reference kept
   * across an await fails rather than writing after the check.
   */
  async swapAtQuit(detach: () => void): Promise<OrchestrationDbSwap> {
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
      await this.dropCopy()
      return { kind }
    }
    try {
      const beforeBytes = await sizeOf(this.filename)
      const walBytes = await sizeOf(`${this.filename}-wal`)
      if (beforeBytes === null || (walBytes ?? 0) > MAX_WAL_BYTES) {
        await this.dropCopy()
        return { kind: 'busy' }
      }
      // From here on nothing else in this process can reach the file.
      refuseOrchestrationDbWritesForReplacement(this.filename)
      detach()
      this.orchestrationDb.close()
      // Its data_version, read before the observer's last read, counts every commit after it.
      lock = new Database(this.filename, { fileMustExist: true })
      const others = Number(lock.pragma('data_version', { simple: true }))
      const observed = this.stamp()
      this.observer?.close()
      this.observer = undefined
      if (observed !== ready.stamp) {
        return await giveUp('stale')
      }
      try {
        // Refused while another connection that has read the file is open (after a short wait for an exiting
        // checkpoint thread); once held, it keeps every other reader and writer out. An external handle that
        // never read holds no lock, so it isn't excluded (see the PR's "Not covered").
        // The checkpoint leaves an empty WAL, so nothing of the old file can be replayed onto the copy.
        lock.exec(
          `PRAGMA busy_timeout = ${LOCK_WAIT_MS}; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;
           PRAGMA wal_checkpoint(TRUNCATE)`
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
      await rename(this.copyPath, this.filename)
      this.ready = undefined
      closeLock()
      await syncDirectory(dirname(this.filename))
      await removeQuietly(this.attemptsPath)
      if (kept) {
        await settlesWithin(removeQuietly(this.replacedPath), UNLINK_WAIT_MS)
      }
      return {
        kind: 'compacted',
        beforeBytes,
        afterBytes: (await sizeOf(this.filename)) ?? 0,
        ms: Math.round(performance.now() - started)
      }
    } catch (error) {
      closeLock()
      await this.dropCopy()
      return { kind: 'failed', error: String(error) }
    }
  }
}
