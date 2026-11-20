import type { ChildProcess } from 'node:child_process'
import { watch, type FSWatcher } from 'node:fs'
import { link, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { spawnProcess } from '@orca/process-host'
import type Database from '../../../../sqlite/sync-database'
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
const SWAP_CAP_MS = 2_000
const UNLINK_WAIT_MS = 1_000

export type OrchestrationDbSwap =
  | { kind: 'none' | 'stale' | 'busy' }
  | { kind: 'compacted'; beforeBytes: number; afterBytes: number; ms: number }
  | { kind: 'failed'; error: string }

// One cached statement: this connection's write counters and the header's page counts (page 1 only).
const FILE_STATE_SQL = `SELECT total_changes() AS changes, d.data_version, s.schema_version, u.user_version,
  a.auto_vacuum, p.page_size, c.page_count, f.freelist_count
  FROM pragma_data_version AS d, pragma_schema_version AS s, pragma_user_version AS u,
    pragma_auto_vacuum AS a, pragma_page_size AS p, pragma_page_count AS c, pragma_freelist_count AS f`

type FileState = {
  /** Changes with any write: this connection's rows, another connection's commit, the schema. */
  fingerprint: string | null
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
    // An open transaction's rows count before they commit, so a copy taken now could miss them.
    fingerprint: db.isTransaction
      ? null
      : [row.changes, row.data_version, row.schema_version, row.user_version].join(':'),
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
  private lastFingerprint: string | null = null
  private quietTicks = 0
  private attempts = 0
  private pastAttempts = 0
  private lastAttemptAt = Number.NEGATIVE_INFINITY
  private copying: ChildProcess | undefined
  private ready: { fingerprint: string } | undefined

  constructor(
    private readonly orchestrationDb: OrchestrationDb,
    private readonly filename: string,
    private readonly isEnabled: () => boolean,
    private readonly quietTicksNeeded = QUIET_TICKS
  ) {}

  private get copyPath(): string {
    return `${this.filename}-compacted`
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
      await Promise.all([removeQuietly(this.copyPath), removeQuietly(this.replacedPath)])
      this.pastAttempts = Number(await readFile(this.attemptsPath, 'utf8').catch(() => '0')) || 0
    }
    const { db } = this.orchestrationDb
    const state = readFileState(db)
    if (!state.legacy) {
      this.finished = true
      await removeQuietly(this.attemptsPath)
      return
    }
    const { fingerprint } = state
    this.quietTicks =
      fingerprint !== null && fingerprint === this.lastFingerprint ? this.quietTicks + 1 : 0
    this.lastFingerprint = fingerprint
    if (this.ready) {
      if (fingerprint === this.ready.fingerprint) {
        return
      }
      this.ready = undefined
      await removeQuietly(this.copyPath)
    }
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
    if (this.stopped || fingerprint === null) {
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
    // Read again after the awaits, right before the child takes its snapshot: any later write shows.
    if (!counted || this.stopped || readFileState(db).fingerprint !== fingerprint) {
      return
    }
    const copied = await this.copy(fingerprint)
    if (copied && !this.stopped && readFileState(db).fingerprint === fingerprint) {
      this.ready = { fingerprint }
    } else if (!this.stopped) {
      await removeQuietly(this.copyPath)
    }
  }

  private copy(fingerprint: string): Promise<boolean> {
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
      // commits (seen on a busy Linux disk). Every commit touches the WAL; the fingerprint stays the judge.
      let walWatch: FSWatcher | undefined
      try {
        walWatch = watch(`${this.filename}-wal`, () => {
          let stale = true
          try {
            stale = readFileState(this.orchestrationDb.db).fingerprint !== fingerprint
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
      void removeQuietly(this.copyPath)
    }
  }

  get hasCopy(): boolean {
    return this.ready !== undefined
  }

  /**
   * At the end of a clean quit: swaps the copy in when the file is unchanged since it was taken. `detach`
   * cuts the runtime off the database; the swap then holds it alone and closes it.
   */
  async swapAtQuit(detach: () => void): Promise<OrchestrationDbSwap> {
    const ready = this.ready
    this.ready = undefined
    if (!ready) {
      return { kind: 'none' }
    }
    const started = performance.now()
    const copy = this.copyPath
    const { db } = this.orchestrationDb
    let open = true
    const closeDb = (): void => {
      if (open) {
        open = false
        this.orchestrationDb.close()
      }
    }
    const giveUp = async (kind: 'busy' | 'stale'): Promise<OrchestrationDbSwap> => {
      closeDb()
      await removeQuietly(copy)
      return { kind }
    }
    try {
      const beforeBytes = await sizeOf(this.filename)
      const walBytes = await sizeOf(`${this.filename}-wal`)
      if (beforeBytes === null || (walBytes ?? 0) > MAX_WAL_BYTES) {
        await removeQuietly(copy)
        return { kind: 'busy' }
      }
      // From here on nothing else in this process can reach the file.
      refuseOrchestrationDbWritesForReplacement(this.filename)
      detach()
      try {
        // Refused while any other connection, in any process, has the file open (after a short wait for
        // a maintenance checkpoint thread still exiting); once held, it keeps every other one out.
        // The checkpoint leaves an empty WAL, so nothing of the old file can be replayed onto the copy.
        db.exec(
          `PRAGMA busy_timeout = ${LOCK_WAIT_MS}; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;
           PRAGMA wal_checkpoint(TRUNCATE)`
        )
      } catch {
        return await giveUp('busy')
      }
      // Under the lock: any commit since the copy, by any connection, shows here.
      if (readFileState(db).fingerprint !== ready.fingerprint) {
        return await giveUp('stale')
      }
      // The second name keeps the old file's blocks alive, so the rename doesn't wait for them to be freed.
      const kept = await link(this.filename, this.replacedPath).then(
        () => true,
        () => false
      )
      // Elsewhere the rename happens under the lock; Windows can't rename over an open file, and its
      // rename fails if anything opened the file since.
      if (process.platform === 'win32') {
        closeDb()
      }
      await rename(copy, this.filename)
      closeDb()
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
      closeDb()
      await removeQuietly(copy)
      return { kind: 'failed', error: String(error) }
    }
  }
}

export type OrchestrationDbQuitOwner = {
  swapCompactedOrchestrationDbForQuit(): Promise<OrchestrationDbSwap>
}

/** Last step of a clean desktop quit, after every other teardown settled: nothing else uses the file. */
export async function swapCompactedOrchestrationDbAtQuit(
  owner: OrchestrationDbQuitOwner | null | undefined
): Promise<void> {
  if (!owner) {
    return
  }
  try {
    const result = await settlesWithin(owner.swapCompactedOrchestrationDbForQuit(), SWAP_CAP_MS)
    if (result === 'late' || result.kind === 'failed') {
      console.warn('[orchestration] database compaction failed', result)
    } else if (result.kind !== 'none') {
      console.info('[orchestration] database compaction', result)
    }
  } catch (error) {
    console.warn('[orchestration] database compaction failed', error)
  }
}
