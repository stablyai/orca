import { open, stat, statfs, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { potentiallyLiveRemoteAttachmentSql } from '../federation/remote-attachment-liveness'
import { runChild, runCompactionChild } from './orchestration-db-compaction-children'
import { openServeBundlePark } from '../../../../../shared/remote-runtime/serve-supervisor/serve-bundle-park'
import { ORCAD_BROWSER_PARK_LABEL } from '../../../../../shared/remote-runtime/serve-supervisor/serve-bundle-coordination'

const MIB = 1024 * 1024
const MIN_FREE_BYTES = 32 * MIB
const MIN_FREE_FRACTION = 0.25
// Quit waits at most QUIT_BUDGET_MS; larger files rarely finish inside it (235 MiB live took 2.9-3.6 s).
const MAX_LIVE_BYTES = 128 * MIB
const QUIT_BUDGET_MS = 2_000
const EXIT_GRACE_MS = 500
const MARKER_WRITE_MS = 250
// How long the child waits for other connections to close; the runtime's checkpoint worker exits async.
const LOCK_WAIT_MS = 300
// Time after the kill grace for rolling back a stopped VACUUM's WAL; launch does it if this runs out.
const RECOVERY_MS = 500
// Our close checkpoints only if the child died after 'ready'; this (journal_size_limit) bounds that close.
const MAX_WAL_BYTES = 8 * MIB

/** Orchestration state another agent or process may still act on; compaction waits for a quit with none. */
export const ACTIVE_ORCHESTRATION_WORK_SQL = `SELECT
  EXISTS(SELECT 1 FROM dispatch_contexts WHERE status IN ('pending', 'dispatched'))
  OR EXISTS(SELECT 1 FROM worker_dispatches
    WHERE state IN ('starting', 'ready', 'start_unknown', 'stopping', 'stop_unknown'))
  OR EXISTS(SELECT 1 FROM worker_terminal_resources
    WHERE ownership_state = 'owned' AND release_state <> 'released')
  OR EXISTS(SELECT 1 FROM remote_dispatch_attachments WHERE ${potentiallyLiveRemoteAttachmentSql()})
  OR EXISTS(SELECT 1 FROM remote_questions WHERE status = 'pending')
  OR EXISTS(SELECT 1 FROM decision_gates WHERE status = 'pending')
  OR EXISTS(SELECT 1 FROM coordinator_runs WHERE status = 'running') AS active`

type PageCounts = { pageSize: number; pages: number; freePages: number }

export type OrchestrationDbCompaction =
  | { kind: 'not-needed' }
  | { kind: 'active' }
  | { kind: 'too-large'; liveBytes: number }
  | { kind: 'low-disk'; neededBytes: number; availableBytes: number }
  | { kind: 'busy' }
  | { kind: 'deferred' }
  | { kind: 'timed-out'; ms: number }
  | { kind: 'compacted'; beforeBytes: number; afterBytes: number; ms: number }
  | { kind: 'failed'; error: string }

/** Files made before incremental auto-vacuum keep freed pages forever; worth one VACUUM only when much is free. */
function isCompactionWarranted({ pageSize, pages, freePages }: PageCounts): boolean {
  return freePages * pageSize >= MIN_FREE_BYTES && freePages >= pages * MIN_FREE_FRACTION
}

/** Where SQLite builds VACUUM's copy: it honors SQLITE_TMPDIR first. */
function sqliteTempDir(): string {
  return process.env.SQLITE_TMPDIR || tmpdir()
}

async function availableBytesIn(dir: string): Promise<number> {
  try {
    const disk = await statfs(dir)
    return Number(disk.bavail) * Number(disk.bsize)
  } catch {
    return 0
  }
}

async function walBacklogExceeds(filename: string, maxBytes: number): Promise<boolean> {
  try {
    return (await stat(`${filename}-wal`)).size > maxBytes
  } catch {
    return false
  }
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

/** The page counts in a SQLite header; null when the file is missing or not a database. */
async function readHeaderCounts(filename: string): Promise<PageCounts | null> {
  let file
  try {
    file = await open(filename, 'r')
  } catch {
    return null
  }
  try {
    const header = Buffer.alloc(100)
    const { bytesRead } = await file.read(header, 0, 100, 0)
    if (bytesRead < 100 || header.toString('latin1', 0, 16) !== 'SQLite format 3\0') {
      return null
    }
    // A nonzero largest-root-page field means auto-vacuum is already on.
    if (header.readUInt32BE(52) !== 0) {
      return null
    }
    const rawPageSize = header.readUInt16BE(16)
    return {
      pageSize: rawPageSize === 1 ? 65536 : rawPageSize,
      pages: header.readUInt32BE(28),
      freePages: header.readUInt32BE(36)
    }
  } finally {
    await file.close()
  }
}

/** Present once an attempt started, and never removed; quit pays the wait for a file at most once. */
function attemptMarker(filename: string): string {
  return `${filename}-compaction-deferred`
}

async function markerExists(filename: string): Promise<boolean> {
  try {
    await stat(attemptMarker(filename))
    return true
  } catch {
    return false
  }
}

/** True only when this quit created the marker, so two quits never both attempt. */
async function claimAttempt(filename: string): Promise<boolean> {
  try {
    await writeFile(attemptMarker(filename), '', { flag: 'wx' })
    return true
  } catch {
    return false
  }
}

export type OrchestrationDbQuitOwner = {
  /** The database file's path (it may not exist), or null when there is none. */
  orchestrationDbFileForQuit(): string | null
  /** Orchestration work in flight, including live coordinators only this process can see. */
  hasActiveOrchestrationWork(deadline: number): Promise<boolean | 'timeout'>
  /** Closes this process's connection and keeps it closed. */
  closeOrchestrationDbForQuit(): void
}

/**
 * One VACUUM of an orchestration database made before incremental auto-vacuum, so it can return pages from
 * then on. `release` runs once the child has joined the file, to close the caller's connection without making
 * that close the last one. Stopped at `budgetMs`, which rolls it back; a busy, active or stopped file is left
 * for a later quit, and the switched file never qualifies again.
 */
export async function compactOrchestrationDb(
  filename: string,
  options: {
    budgetMs?: number
    /** True, false, or 'timeout' when it couldn't decide by `deadline` (performance.now()). */
    isActive?: (deadline: number) => boolean | 'timeout' | Promise<boolean | 'timeout'>
    release?: () => void
  } = {}
): Promise<OrchestrationDbCompaction> {
  const { budgetMs = QUIT_BUDGET_MS, isActive = () => false, release = () => {} } = options
  // The budget covers the checks too, so a slow disk or long history can't stretch quit past it.
  const started = performance.now()
  // A cheap first look, so ordinary quits do nothing else; the child decides on SQLite's own view.
  const counts = await readHeaderCounts(filename)
  if (!counts || !isCompactionWarranted(counts)) {
    return { kind: 'not-needed' }
  }
  const liveBytes = (counts.pages - counts.freePages) * counts.pageSize
  if (liveBytes > MAX_LIVE_BYTES) {
    return { kind: 'too-large', liveBytes }
  }
  if (await markerExists(filename)) {
    return { kind: 'deferred' }
  }
  const neededBytes = 2 * counts.pages * counts.pageSize
  const availableBytes = await availableBytesIn(dirname(filename))
  if (availableBytes < neededBytes || (await availableBytesIn(sqliteTempDir())) < liveBytes) {
    return { kind: 'low-disk', neededBytes, availableBytes }
  }
  if (await walBacklogExceeds(filename, MAX_WAL_BYTES)) {
    return { kind: 'busy' }
  }
  const active = await isActive(started + budgetMs)
  if (active === 'timeout') {
    // A history too long to check in time would cost the full wait on every quit; count it as the one try.
    const timedOut = { kind: 'timed-out' as const, ms: Math.round(performance.now() - started) }
    await settlesWithin(claimAttempt(filename), MARKER_WRITE_MS)
    return timedOut
  }
  if (active) {
    return { kind: 'active' }
  }
  // Claimed before the wait, so a quit cut off mid-attempt still counts as the one wait it paid. A disk
  // that can't write it promptly gets no attempt; if the write lands later it just defers the file.
  if ((await settlesWithin(claimAttempt(filename), MARKER_WRITE_MS)) !== true) {
    return { kind: 'busy' }
  }
  const remainingMs = budgetMs - (performance.now() - started)
  const { result, heldLock } =
    remainingMs > 0
      ? await runCompactionChild({
          filename,
          budgetMs: remainingMs,
          graceMs: EXIT_GRACE_MS,
          release,
          started,
          job: {
            tempDir: sqliteTempDir(),
            minFreeBytes: MIN_FREE_BYTES,
            minFreeFraction: MIN_FREE_FRACTION,
            maxLiveBytes: MAX_LIVE_BYTES,
            activeWorkSql: ACTIVE_ORCHESTRATION_WORK_SQL,
            lockWaitMs: LOCK_WAIT_MS
          }
        })
      : {
          result: { kind: 'timed-out' as const, ms: Math.round(performance.now() - started) },
          heldLock: false
        }
  // The marker stays whatever the result: a compacted file never qualifies again, and any other attempt
  // may already have cost the user its one wait.
  if (heldLock && (result.kind === 'timed-out' || result.kind === 'failed')) {
    // A VACUUM stopped under its exclusive lock leaves its copy in the WAL; clear it now, after the
    // windows closed, rather than on the next launch's first open.
    const leftMs = budgetMs + EXIT_GRACE_MS + RECOVERY_MS - (performance.now() - started)
    await runChild(filename, { recoverOnly: true }, Math.max(leftMs, 0))
  }
  return result
}

/** A macOS app update stops a headless server to replace the bundle; that stop must not wait on compaction. */
export function isAppBundleParkedForInstall(): boolean {
  try {
    return (
      openServeBundlePark({
        executable: process.execPath,
        label: ORCAD_BROWSER_PARK_LABEL
      })?.holds() ?? false
    )
  } catch {
    return true
  }
}

/** Last step of a clean quit, after every other teardown settled: nothing else uses the file. */
export async function compactOrchestrationDbAtQuit(
  owner: OrchestrationDbQuitOwner | null | undefined
): Promise<void> {
  let cap: NodeJS.Timeout | undefined
  // Quit never waits past the budget plus the kill grace, whatever the disk does.
  const capped = new Promise<void>((resolve) => {
    cap = setTimeout(resolve, QUIT_BUDGET_MS + EXIT_GRACE_MS + RECOVERY_MS + 50)
    cap.unref()
  })
  await Promise.race([compactAtQuit(owner), capped])
  clearTimeout(cap)
}

async function compactAtQuit(owner: OrchestrationDbQuitOwner | null | undefined): Promise<void> {
  try {
    const filename = owner?.orchestrationDbFileForQuit()
    if (!owner || !filename) {
      return
    }
    const result = await compactOrchestrationDb(filename, {
      isActive: (deadline) => owner.hasActiveOrchestrationWork(deadline),
      release: () => owner.closeOrchestrationDbForQuit()
    })
    if (result.kind === 'failed') {
      console.warn('[orchestration] database compaction failed', result.error)
    } else if (result.kind !== 'not-needed') {
      console.info('[orchestration] database compaction', result)
    }
  } catch (error) {
    console.warn('[orchestration] database compaction failed', error)
  }
}
