import type { ChildProcess } from 'node:child_process'
import { link, open, rename, rm, stat, statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import { spawnProcess } from '@orca/process-host'
import type Database from '../../../../sqlite/sync-database'
import type { OrchestrationDb } from '../orchestration-db'
import { compactionChildSource } from './orchestration-db-compaction-child-source'

const MIB = 1024 * 1024
const MIN_FREE_BYTES = 32 * MIB
const MIN_FREE_FRACTION = 0.25
// Maintenance minutes with no write before copying; a write after the copy makes it stale.
const QUIET_TICKS = 5
// A copy that keeps going stale costs one background copy an hour, three per session at most.
const ATTEMPTS_PER_SESSION = 3
const ATTEMPT_SPACING_MS = 60 * 60_000
// The copy blocks no one; this only bounds the disk and CPU it uses.
const COPY_BUDGET_MS = 120_000
// journal_size_limit: closing at quit checkpoints at most this much.
const MAX_WAL_BYTES = 8 * MIB
const SWAP_CAP_MS = 2_000
const UNLINK_WAIT_MS = 1_000

export type OrchestrationDbSwap =
  | { kind: 'none' | 'stale' | 'busy' }
  | { kind: 'compacted'; beforeBytes: number; afterBytes: number; ms: number }
  | { kind: 'failed'; error: string }

/** Changes with any write to the file: this connection's rows, another connection's commit, the schema. */
function writeFingerprint(db: Database.Database): string | null {
  // An open transaction's rows count before they commit, so a copy taken now could miss them.
  if (db.isTransaction) {
    return null
  }
  const changes = db.prepare('SELECT total_changes() AS changes').get()?.changes
  const pragmas = ['data_version', 'schema_version', 'user_version'].map((name) =>
    db.pragma(name, { simple: true })
  )
  return [changes, ...pragmas].join(':')
}

/** Live bytes of a file made before incremental auto-vacuum with enough free pages to be worth a copy. */
function legacyLiveBytes(db: Database.Database): number | null {
  const pageSize = Number(db.pragma('page_size', { simple: true }))
  const pages = Number(db.pragma('page_count', { simple: true }))
  const freePages = Number(db.pragma('freelist_count', { simple: true }))
  const warranted = freePages * pageSize >= MIN_FREE_BYTES && freePages >= pages * MIN_FREE_FRACTION
  return warranted ? (pages - freePages) * pageSize : null
}

async function availableBytesIn(dir: string): Promise<number> {
  try {
    const disk = await statfs(dir)
    return Number(disk.bavail) * Number(disk.bsize)
  } catch {
    return 0
  }
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size
  } catch {
    return null
  }
}

function removeQuietly(path: string): Promise<void> {
  return rm(path, { force: true }).catch(() => {})
}

/** The work's result, or 'late' when it hasn't settled within `ms`. */
async function settlesWithin<T>(work: Promise<T>, ms: number): Promise<T | 'late'> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), ms)
  })
  try {
    return await Promise.race([work, late])
  } finally {
    clearTimeout(timer)
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

  /** Called once per maintenance minute. */
  async tick(): Promise<void> {
    if (this.finished || this.stopped || this.copying || !this.isEnabled()) {
      return
    }
    const { db } = this.orchestrationDb
    if (Number(db.pragma('auto_vacuum', { simple: true })) !== 0) {
      this.finished = true
      return
    }
    const fingerprint = writeFingerprint(db)
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
    if (!this.leftoversRemoved) {
      // From a session that quit or crashed part-way.
      this.leftoversRemoved = true
      await Promise.all([removeQuietly(this.copyPath), removeQuietly(this.replacedPath)])
    }
    if (
      this.quietTicks < this.quietTicksNeeded ||
      this.attempts >= ATTEMPTS_PER_SESSION ||
      Date.now() - this.lastAttemptAt < ATTEMPT_SPACING_MS
    ) {
      return
    }
    const liveBytes = legacyLiveBytes(db)
    if (liveBytes === null) {
      return
    }
    // Room for the copy beside the file, with as much again to spare.
    if ((await availableBytesIn(dirname(this.filename))) < 2 * liveBytes) {
      return
    }
    // Read again after the await, right before the child takes its snapshot: any later write shows.
    if (this.stopped || fingerprint === null || writeFingerprint(db) !== fingerprint) {
      return
    }
    this.attempts++
    this.lastAttemptAt = Date.now()
    const copied = await this.copy()
    if (copied && !this.stopped && writeFingerprint(db) === fingerprint) {
      this.ready = { fingerprint }
    } else if (!this.stopped) {
      await removeQuietly(this.copyPath)
    }
  }

  private copy(): Promise<boolean> {
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
              target: this.copyPath
            })
          },
          stdio: 'ignore'
        })
      } catch {
        resolve(false)
        return
      }
      this.copying = child
      const budget = setTimeout(() => child.kill('SIGKILL'), COPY_BUDGET_MS)
      // Any exit, update installs included: a child left running would hold the app's executable open.
      const killOnExit = (): void => {
        child.kill('SIGKILL')
      }
      process.once('exit', killOnExit)
      const done = (copied: boolean): void => {
        clearTimeout(budget)
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

  /**
   * At the end of a clean quit: swaps the copy in when the file is unchanged since it was taken. `close`
   * closes the runtime's connection for good, which checkpoints its small WAL.
   */
  async swapAtQuit(close: () => void): Promise<OrchestrationDbSwap> {
    const ready = this.ready
    this.ready = undefined
    if (!ready) {
      return { kind: 'none' }
    }
    const started = performance.now()
    const copy = this.copyPath
    try {
      const beforeBytes = await sizeOf(this.filename)
      const walBytes = await sizeOf(`${this.filename}-wal`)
      if (beforeBytes === null || (walBytes ?? 0) > MAX_WAL_BYTES) {
        await removeQuietly(copy)
        return { kind: 'busy' }
      }
      // Synchronously before the close, so nothing can write in between.
      if (writeFingerprint(this.orchestrationDb.db) !== ready.fingerprint) {
        await removeQuietly(copy)
        return { kind: 'stale' }
      }
      close()
      // The last connection's close removes the WAL; one left means another still has the file open.
      if ((await sizeOf(`${this.filename}-wal`)) !== null) {
        await removeQuietly(copy)
        return { kind: 'busy' }
      }
      // A second name keeps the old file's blocks alive, so the rename doesn't wait for them to be freed.
      const kept = await link(this.filename, this.replacedPath).then(
        () => true,
        () => false
      )
      await rename(copy, this.filename)
      await syncDirectory(dirname(this.filename))
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
      await removeQuietly(copy)
      return { kind: 'failed', error: String(error) }
    }
  }
}

/** Makes the rename durable; Windows can't open a directory and its renames are already written through. */
async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') {
    return
  }
  try {
    const handle = await open(dir, 'r')
    await handle.sync().finally(() => handle.close())
  } catch {
    // Some file systems refuse to sync a directory; the rename itself already happened.
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
