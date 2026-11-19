import { open, readFile, rm, statfs, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnProcess } from '@orca/process-host'
import { potentiallyLiveRemoteAttachmentSql } from '../federation/remote-attachment-liveness'
import { compactionChildSource } from './orchestration-db-compaction-child-source'

const MIB = 1024 * 1024
const MIN_FREE_BYTES = 32 * MIB
const MIN_FREE_FRACTION = 0.25
// Quit waits at most QUIT_BUDGET_MS; larger files rarely finish inside it (235 MiB live took 2.9-3.6 s).
const MAX_LIVE_BYTES = 128 * MIB
const QUIT_BUDGET_MS = 2_000
const EXIT_GRACE_MS = 500
// Quit pays the wait once: a stopped attempt waits until the live data shrinks this much.
const MAX_TIMEOUTS = 1
const RETRY_LIVE_FRACTION = 0.75

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
  | { kind: 'deferred'; timeouts: number }
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

function readChildResult(output: string): OrchestrationDbCompaction | null {
  try {
    const parsed: unknown = JSON.parse(output.trim().split('\n').at(-1) ?? '')
    return typeof parsed === 'object' && parsed !== null && 'kind' in parsed
      ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: written by compactionChildSource above.
        (parsed as OrchestrationDbCompaction)
      : null
  } catch {
    return null
  }
}

type CompactionDeferral = { liveBytes: number; timeouts: number }

function deferralFile(filename: string): string {
  return `${filename}-compaction-deferred`
}

async function readDeferral(filename: string): Promise<CompactionDeferral | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(deferralFile(filename), 'utf8'))
    return typeof parsed === 'object' &&
      parsed !== null &&
      'liveBytes' in parsed &&
      typeof parsed.liveBytes === 'number' &&
      'timeouts' in parsed &&
      typeof parsed.timeouts === 'number'
      ? { liveBytes: parsed.liveBytes, timeouts: parsed.timeouts }
      : null
  } catch {
    return null
  }
}

/** Remembers stopped attempts, so a disk too slow for the budget doesn't pay it on every quit. */
async function recordOutcome(
  filename: string,
  liveBytes: number,
  result: OrchestrationDbCompaction
): Promise<void> {
  try {
    if (result.kind === 'timed-out') {
      const previous = await readDeferral(filename)
      await writeFile(
        deferralFile(filename),
        JSON.stringify({ liveBytes, timeouts: (previous?.timeouts ?? 0) + 1 })
      )
    } else if (result.kind === 'compacted') {
      await rm(deferralFile(filename), { force: true })
    }
  } catch {
    // Only a retry hint; losing it costs one more bounded attempt.
  }
}

export type OrchestrationDbQuitOwner = {
  /** The database file, or null when there is none. */
  orchestrationDbFileForQuit(): string | null
  /** Orchestration work in flight, including live coordinators only this process can see. */
  hasActiveOrchestrationWork(): boolean
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
  options: { budgetMs?: number; isActive?: () => boolean; release?: () => void } = {}
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
  const deferral = await readDeferral(filename)
  if (
    deferral &&
    deferral.timeouts >= MAX_TIMEOUTS &&
    liveBytes > deferral.liveBytes * RETRY_LIVE_FRACTION
  ) {
    return { kind: 'deferred', timeouts: deferral.timeouts }
  }
  const neededBytes = 2 * counts.pages * counts.pageSize
  const availableBytes = await availableBytesIn(dirname(filename))
  if (availableBytes < neededBytes || (await availableBytesIn(sqliteTempDir())) < liveBytes) {
    return { kind: 'low-disk', neededBytes, availableBytes }
  }
  if (isActive()) {
    return { kind: 'active' }
  }
  const remainingMs = budgetMs - (performance.now() - started)
  const result =
    remainingMs > 0
      ? await runCompactionChild(filename, remainingMs, release, started)
      : { kind: 'timed-out' as const, ms: Math.round(performance.now() - started) }
  await recordOutcome(filename, liveBytes, result)
  return result
}

function runCompactionChild(
  filename: string,
  budgetMs: number,
  release: () => void,
  started: number
): Promise<OrchestrationDbCompaction> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawnProcess>
    try {
      child = spawnProcess({
        program: process.execPath,
        args: ['-e', compactionChildSource],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          ORCA_ORCHESTRATION_COMPACTION: JSON.stringify({
            filename,
            tempDir: sqliteTempDir(),
            minFreeBytes: MIN_FREE_BYTES,
            minFreeFraction: MIN_FREE_FRACTION,
            maxLiveBytes: MAX_LIVE_BYTES,
            activeWorkSql: ACTIVE_ORCHESTRATION_WORK_SQL
          })
        },
        stdio: 'pipe'
      })
    } catch (error) {
      resolve({ kind: 'failed', error: String(error) })
      return
    }
    let output = ''
    let released = false
    let timedOut = false
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      if (!released && output.startsWith('ready\n')) {
        released = true
        // A child gone after 'ready' would make our close the last one, which checkpoints on quit.
        if (child.exitCode !== null || child.signalCode !== null) {
          return
        }
        try {
          release()
          child.stdin?.end('go\n')
        } catch (error) {
          child.kill('SIGKILL')
          finish({ kind: 'failed', error: String(error) })
        }
      }
    })
    let grace: NodeJS.Timeout | undefined
    const finish = (result: OrchestrationDbCompaction): void => {
      clearTimeout(budget)
      clearTimeout(grace)
      resolve(result)
    }
    // Killing it rolls the VACUUM back; quit then waits briefly for the lock to drop, never longer.
    const budget = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
      grace = setTimeout(
        () => finish({ kind: 'timed-out', ms: Math.round(performance.now() - started) }),
        EXIT_GRACE_MS
      )
    }, budgetMs)
    child.once('error', (error) => finish({ kind: 'failed', error: String(error) }))
    child.once('close', () =>
      finish(
        timedOut
          ? { kind: 'timed-out', ms: Math.round(performance.now() - started) }
          : (readChildResult(output) ?? { kind: 'failed', error: 'no result from compaction' })
      )
    )
  })
}

/** Last step of a clean quit, after every other teardown settled: nothing else uses the file. */
export async function compactOrchestrationDbAtQuit(
  owner: OrchestrationDbQuitOwner | null | undefined
): Promise<void> {
  let cap: NodeJS.Timeout | undefined
  // Quit never waits past the budget plus the kill grace, whatever the disk does.
  const capped = new Promise<void>((resolve) => {
    cap = setTimeout(resolve, QUIT_BUDGET_MS + EXIT_GRACE_MS + 250)
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
      isActive: () => owner.hasActiveOrchestrationWork(),
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
