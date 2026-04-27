/* eslint-disable max-lines -- Why: the collector's platform-specific
   enumeration paths (`ps` on Unix, `wmic` on Windows) plus the history
   ring buffer plus the Electron bucketing live together to keep one
   snapshot's worth of code in one place. Splitting them produces extra
   modules whose only consumer is this file. */
/**
 * Memory dashboard collector.
 *
 * One snapshot covers two sources:
 *   - Orca's own Electron processes, via `app.getAppMetrics()`, bucketed
 *     into main / renderer / other.
 *   - Each registered PTY's process subtree, enumerated once from a host-
 *     wide `ps` sweep (`wmic` on Windows).
 *
 * Memory samples are held in a per-key ring (one key per worktree, plus
 * a reserved app-total key) so the UI can draw a trend sparkline.
 *
 * Concurrent callers coalesce onto a single in-flight sweep so a burst of
 * renderer polls never produces overlapping child processes.
 */

import { basename } from 'node:path'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import { app } from 'electron'
import type {
  AppMemory,
  MemorySnapshot,
  HostMemory,
  SessionMemory,
  WorktreeMemory
} from '../../shared/types'
import type { Store } from '../persistence'
import { ORPHAN_WORKTREE_ID } from '../../shared/constants'
import { listRegisteredPtys } from './pty-registry'

// ─── Module state ───────────────────────────────────────────────────

let inflight: Promise<MemorySnapshot> | null = null

// ─── Public API ─────────────────────────────────────────────────────

export async function collectMemorySnapshot(store: Store): Promise<MemorySnapshot> {
  // Why: coalescing relies on the persistence store being a process-wide
  // singleton at runtime. Concurrent callers all hand in the same instance,
  // so it is safe to return the existing in-flight promise (which was
  // kicked off with that same store) rather than starting a second sweep.
  if (inflight) {
    return inflight
  }
  inflight = runSnapshot(store)
    .catch((err) => {
      console.warn('[memory] snapshot failed; returning empty', err)
      return emptySnapshot()
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

// ─── Internals ──────────────────────────────────────────────────────

const execAsync = promisify(exec)
const PS_EXEC_TIMEOUT_MS = 5_000
const PS_MAX_BUFFER = 10 * 1024 * 1024

/** One row from the host-wide process listing. */
type ProcRow = {
  pid: number
  ppid: number
  /** Percent of one core (may exceed 100 on multi-core). 0 on Windows. */
  cpu: number
  /** Resident memory in bytes. */
  memory: number
}

/** Indexed view of a single `ps`/`wmic` sweep. */
type ProcIndex = {
  byPid: Map<number, ProcRow>
  childrenOf: Map<number, number[]>
}

function clampNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0
  }
  return Math.max(0, value)
}

function hostMetrics(): HostMemory {
  const total = clampNumber(os.totalmem())
  const free = clampNumber(os.freemem())
  const used = Math.max(0, total - free)
  return {
    totalMemory: total,
    freeMemory: free,
    usedMemory: used,
    memoryUsagePercent: total > 0 ? (used / total) * 100 : 0,
    cpuCoreCount: Math.max(1, os.cpus().length),
    loadAverage1m: clampNumber(os.loadavg()[0])
  }
}

function emptySnapshot(): MemorySnapshot {
  const zero = { cpu: 0, memory: 0 }
  return {
    app: { ...zero, main: zero, renderer: zero, other: zero, history: [] },
    worktrees: [],
    host: hostMetrics(),
    totalCpu: 0,
    totalMemory: 0,
    collectedAt: Date.now()
  }
}

// ─── History ring buffers ───────────────────────────────────────────

const APP_HISTORY_KEY = '__app__'
const HISTORY_CAPACITY = 60
const HISTORY_STALE_MS = 10 * 60 * 1000

type HistoryRing = {
  samples: number[]
  touchedAt: number
}

const historyByKey = new Map<string, HistoryRing>()

function pushHistorySample(key: string, memoryBytes: number, now: number): void {
  let ring = historyByKey.get(key)
  if (!ring) {
    ring = { samples: [], touchedAt: now }
    historyByKey.set(key, ring)
  }
  ring.samples.push(memoryBytes)
  if (ring.samples.length > HISTORY_CAPACITY) {
    ring.samples.shift()
  }
  ring.touchedAt = now
}

function readHistory(key: string): number[] {
  const ring = historyByKey.get(key)
  return ring ? [...ring.samples] : []
}

function sweepStaleHistory(now: number): void {
  for (const [key, ring] of historyByKey) {
    if (now - ring.touchedAt > HISTORY_STALE_MS) {
      historyByKey.delete(key)
    }
  }
}

// ─── Host process enumeration ───────────────────────────────────────

async function enumerateProcesses(): Promise<ProcIndex> {
  const rows = os.platform() === 'win32' ? await enumerateWindows() : await enumerateUnix()

  const byPid = new Map<number, ProcRow>()
  const childrenOf = new Map<number, number[]>()

  for (const row of rows) {
    byPid.set(row.pid, row)
    const siblings = childrenOf.get(row.ppid)
    if (siblings) {
      siblings.push(row.pid)
    } else {
      childrenOf.set(row.ppid, [row.pid])
    }
  }

  return { byPid, childrenOf }
}

async function enumerateUnix(): Promise<ProcRow[]> {
  // Why: `-o pcpu` formats the percentage with the current locale's decimal
  // separator (e.g. "12,5" on de_DE). parseFloat is locale-agnostic and
  // silently drops the fractional part at a comma. Forcing C locale keeps
  // decimals as dots.
  try {
    const { stdout } = await execAsync('ps -eo pid=,ppid=,pcpu=,rss=', {
      maxBuffer: PS_MAX_BUFFER,
      timeout: PS_EXEC_TIMEOUT_MS,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' }
    })
    return parsePsOutput(stdout)
  } catch (err) {
    console.warn('[memory] ps enumeration failed', err)
    return []
  }
}

/** Exported for tests: parses `ps -eo pid=,ppid=,pcpu=,rss=` output. */
export function parsePsOutput(stdout: string): ProcRow[] {
  const rows: ProcRow[] = []
  const lines = stdout.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line.length === 0) {
      continue
    }
    // Split on runs of whitespace. We requested exactly 4 columns.
    const fields = line.split(/\s+/, 4)
    if (fields.length < 4) {
      continue
    }
    const pid = Number.parseInt(fields[0], 10)
    const ppid = Number.parseInt(fields[1], 10)
    const cpu = Number.parseFloat(fields[2])
    const rssKb = Number.parseInt(fields[3], 10)
    if (Number.isNaN(pid) || Number.isNaN(ppid)) {
      continue
    }
    rows.push({
      pid,
      ppid,
      cpu: Number.isFinite(cpu) && cpu > 0 ? cpu : 0,
      memory: Number.isFinite(rssKb) && rssKb > 0 ? rssKb * 1024 : 0
    })
  }
  return rows
}

async function enumerateWindows(): Promise<ProcRow[]> {
  // Why: `wmic` ships with stock Windows and emits a plain, tab-separated
  // table without the CSV-quoting edge cases PowerShell's ConvertTo-Csv
  // introduces. CPU% would require delta sampling between two queries; for
  // v1 we report 0% on Windows — memory attribution is the primary signal.
  try {
    const { stdout } = await execAsync(
      'wmic process get ProcessId,ParentProcessId,WorkingSetSize /format:value',
      { maxBuffer: PS_MAX_BUFFER, timeout: PS_EXEC_TIMEOUT_MS }
    )
    return parseWmicOutput(stdout)
  } catch (err) {
    console.warn('[memory] wmic enumeration failed', err)
    return []
  }
}

/** Exported for tests: parses `wmic /format:value` stanza output. */
export function parseWmicOutput(stdout: string): ProcRow[] {
  // wmic /format:value emits stanzas of `Key=Value` lines separated by blank
  // lines. We accumulate a record until a blank line, then flush.
  const rows: ProcRow[] = []
  let pid = Number.NaN
  let ppid = Number.NaN
  let ws = Number.NaN

  const flush = (): void => {
    if (!Number.isNaN(pid) && !Number.isNaN(ppid)) {
      rows.push({
        pid,
        ppid,
        cpu: 0,
        memory: Number.isFinite(ws) && ws > 0 ? ws : 0
      })
    }
    pid = Number.NaN
    ppid = Number.NaN
    ws = Number.NaN
  }

  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length === 0) {
      flush()
      continue
    }
    const eq = line.indexOf('=')
    if (eq < 0) {
      continue
    }
    const key = line.slice(0, eq)
    const value = line.slice(eq + 1)
    if (key === 'ProcessId') {
      pid = Number.parseInt(value, 10)
    } else if (key === 'ParentProcessId') {
      ppid = Number.parseInt(value, 10)
    } else if (key === 'WorkingSetSize') {
      ws = Number.parseInt(value, 10)
    }
  }
  flush()
  return rows
}

/** Walk every descendant PID of `root`, inclusive. Exported for tests. */
export function collectSubtree(index: ProcIndex, root: number): number[] {
  const result: number[] = []
  const seen = new Set<number>()
  const queue = [root]
  while (queue.length > 0) {
    const pid = queue.pop()
    if (pid === undefined) {
      break
    }
    if (seen.has(pid)) {
      continue
    }
    seen.add(pid)
    if (index.byPid.has(pid)) {
      result.push(pid)
    }
    const kids = index.childrenOf.get(pid)
    if (kids) {
      for (const kid of kids) {
        queue.push(kid)
      }
    }
  }
  return result
}

// ─── Electron app process bucketing ─────────────────────────────────

type AppBucketsRaw = Omit<AppMemory, 'history'>

function bucketElectronMetrics(): AppBucketsRaw {
  const main = { cpu: 0, memory: 0 }
  const renderer = { cpu: 0, memory: 0 }
  const other = { cpu: 0, memory: 0 }

  for (const proc of app.getAppMetrics()) {
    const cpu = clampNumber(proc.cpu?.percentCPUUsage)
    // Electron reports workingSetSize in KB. Convert up front so every
    // memory value in the snapshot is in bytes.
    const memoryBytes = clampNumber(proc.memory?.workingSetSize) * 1024

    // Why: lowercase once so future Electron versions emitting different
    // casing ('browser' vs 'Browser') still bucket correctly.
    const type = (typeof proc.type === 'string' ? proc.type : '').toLowerCase()
    let target = other
    if (type === 'browser') {
      target = main
    } else if (type === 'renderer' || type === 'tab') {
      target = renderer
    }

    target.cpu += cpu
    target.memory += memoryBytes
  }

  return {
    main,
    renderer,
    other,
    cpu: main.cpu + renderer.cpu + other.cpu,
    memory: main.memory + renderer.memory + other.memory
  }
}

// ─── Worktree attribution ───────────────────────────────────────────

type WorktreeBucket = {
  worktreeId: string
  worktreeName: string
  repoId: string
  repoName: string
  cpu: number
  memory: number
  sessions: SessionMemory[]
}

function resolveWorktreeNames(
  worktreeId: string,
  store: Store
): {
  worktreeName: string
  repoId: string
  repoName: string
} {
  // Orca worktree ids look like `${repoId}::${absolutePath}`.
  const sep = worktreeId.indexOf('::')
  const repoId = sep > 0 ? worktreeId.slice(0, sep) : worktreeId
  const worktreePath = sep > 0 ? worktreeId.slice(sep + 2) : ''
  const fallbackName = worktreePath ? basename(worktreePath) : worktreeId

  const meta = store.getWorktreeMeta(worktreeId)
  const repo = store.getRepo(repoId)

  return {
    worktreeName: meta?.displayName?.trim() || fallbackName,
    repoId,
    repoName: repo?.displayName?.trim() || repoId || 'Unknown Repo'
  }
}

function makeEmptyBucket(
  worktreeId: string,
  worktreeName: string,
  repoId: string,
  repoName: string
): WorktreeBucket {
  return { worktreeId, worktreeName, repoId, repoName, cpu: 0, memory: 0, sessions: [] }
}

// ─── Main collection path ───────────────────────────────────────────

async function runSnapshot(store: Store): Promise<MemorySnapshot> {
  const processIndex = await enumerateProcesses()
  const appBuckets = bucketElectronMetrics()
  const ptys = listRegisteredPtys()

  // Why: when two PTYs share an ancestor in the process tree (e.g. a
  // supervisor, or a shell that re-execed), a naive walk would double-count
  // that ancestor's memory. Track which pids have already been claimed and
  // attribute to the first PTY (registration order) to see each pid.
  const claimed = new Set<number>()

  const orphan = makeEmptyBucket(
    ORPHAN_WORKTREE_ID,
    'Unattributed terminals',
    ORPHAN_WORKTREE_ID,
    'Other'
  )
  const worktreeBuckets = new Map<string, WorktreeBucket>()

  for (const pty of ptys) {
    let sessionCpu = 0
    let sessionMemory = 0

    if (pty.pid != null) {
      for (const pid of collectSubtree(processIndex, pty.pid)) {
        if (claimed.has(pid)) {
          continue
        }
        const row = processIndex.byPid.get(pid)
        if (!row) {
          continue
        }
        claimed.add(pid)
        sessionCpu += row.cpu
        sessionMemory += row.memory
      }
    }

    const session: SessionMemory = {
      sessionId: pty.sessionId ?? pty.ptyId,
      paneKey: pty.paneKey,
      pid: pty.pid ?? 0,
      cpu: clampNumber(sessionCpu),
      memory: clampNumber(sessionMemory)
    }

    let bucket: WorktreeBucket
    if (pty.worktreeId) {
      const existing = worktreeBuckets.get(pty.worktreeId)
      if (existing) {
        bucket = existing
      } else {
        const names = resolveWorktreeNames(pty.worktreeId, store)
        bucket = makeEmptyBucket(pty.worktreeId, names.worktreeName, names.repoId, names.repoName)
        worktreeBuckets.set(pty.worktreeId, bucket)
      }
    } else {
      bucket = orphan
    }

    bucket.cpu += session.cpu
    bucket.memory += session.memory
    bucket.sessions.push(session)
  }

  const bucketList: WorktreeBucket[] = [...worktreeBuckets.values()]
  if (orphan.sessions.length > 0) {
    bucketList.push(orphan)
  }

  // Why: record this sweep's samples *before* reading back history, so the
  // returned arrays end with the freshly-collected value. Each write also
  // acts as a keep-alive so active worktrees survive the staleness sweep.
  const now = Date.now()
  pushHistorySample(APP_HISTORY_KEY, appBuckets.memory, now)
  for (const bucket of bucketList) {
    pushHistorySample(bucket.worktreeId, bucket.memory, now)
  }
  sweepStaleHistory(now)

  const worktrees: WorktreeMemory[] = bucketList.map((b) => ({
    ...b,
    history: readHistory(b.worktreeId)
  }))

  let sessionCpuTotal = 0
  let sessionMemoryTotal = 0
  for (const wt of worktrees) {
    sessionCpuTotal += wt.cpu
    sessionMemoryTotal += wt.memory
  }

  return {
    app: { ...appBuckets, history: readHistory(APP_HISTORY_KEY) },
    worktrees,
    host: hostMetrics(),
    totalCpu: appBuckets.cpu + sessionCpuTotal,
    totalMemory: appBuckets.memory + sessionMemoryTotal,
    collectedAt: now
  }
}
