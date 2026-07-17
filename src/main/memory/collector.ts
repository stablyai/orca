/* eslint-disable max-lines -- Why: the collector's platform-specific
   enumeration paths (`ps` on Unix, `typeperf`/CIM on Windows) plus the history
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
 *     wide process sweep (`typeperf` with a PowerShell CIM fallback on Windows).
 *
 * Memory samples are held in a per-key ring (one key per worktree, plus
 * a reserved app-total key) so the UI can draw a trend sparkline.
 *
 * Concurrent callers coalesce onto a single in-flight sweep so a burst of
 * renderer polls never produces overlapping child processes.
 */

import { basename } from 'node:path'
import { exec, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { performance } from 'node:perf_hooks'
import os from 'node:os'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree-id'
import {
  getProcessOutputFields,
  iterateProcessOutputLines
} from '../../shared/process-output-field-scanner'
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

export type MemorySnapshotStore = Pick<Store, 'getRepo' | 'getWorktreeMeta'>

// ─── Module state ───────────────────────────────────────────────────

let inflight: Promise<MemorySnapshot> | null = null
let windowsProcessBackend: 'typeperf' | 'cim' = 'typeperf'
let previousWindowsCpuSample: WindowsCpuSample | null = null

// ─── Public API ─────────────────────────────────────────────────────

export async function collectMemorySnapshot(store: MemorySnapshotStore): Promise<MemorySnapshot> {
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
const TYPEPERF_COUNTERS = [
  '\\Process(*)\\ID Process',
  '\\Process(*)\\Creating Process ID',
  '\\Process(*)\\Working Set'
] as const
const TYPEPERF_MAX_FIELDS = 8_192
const TYPEPERF_MAX_LINE_CHARS = 1024 * 1024

/** One row from the host-wide process listing. */
type ProcRow = {
  pid: number
  ppid: number
  /** Percent of one core (may exceed 100 on multi-core). */
  cpu: number
  /** Resident memory in bytes. */
  memory: number
}

/** Indexed view of a single host process sweep. */
type ProcIndex = {
  byPid: Map<number, ProcRow>
  childrenOf: Map<number, number[]>
}

type WindowsCpuTimes = {
  cpuTicks: number
  startTimeId: string
}

type WindowsCpuSample = {
  sampledAtMs: number
  byPid: Map<number, WindowsCpuTimes>
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
  for (const line of iterateProcessOutputLines(stdout)) {
    const fields = getProcessOutputFields(line, 4)
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
  // Why: Typeperf's formatted CPU counter blocks for a rate interval. Sampling
  // cumulative process time in parallel keeps the existing fast memory path.
  const [rows, cpuSample] = await Promise.all([
    enumerateWindowsProcessRows(),
    enumerateWindowsCpuSample()
  ])
  if (!cpuSample) {
    return rows
  }

  const previous = previousWindowsCpuSample
  previousWindowsCpuSample = cpuSample
  if (!previous) {
    return rows
  }
  const elapsedMs = cpuSample.sampledAtMs - previous.sampledAtMs
  if (elapsedMs <= 0) {
    return rows
  }
  for (const row of rows) {
    const currentTimes = cpuSample.byPid.get(row.pid)
    const previousTimes = previous.byPid.get(row.pid)
    // Start time distinguishes a live process from a later process that reused
    // the same PID; counter resets likewise produce a zero sample, not a spike.
    if (
      !currentTimes ||
      !previousTimes ||
      currentTimes.startTimeId !== previousTimes.startTimeId ||
      currentTimes.cpuTicks < previousTimes.cpuTicks
    ) {
      continue
    }
    const cpuMs = (currentTimes.cpuTicks - previousTimes.cpuTicks) / 10_000
    row.cpu = clampNumber((cpuMs / elapsedMs) * 100)
  }
  return rows
}

async function enumerateWindowsProcessRows(): Promise<ProcRow[]> {
  // Why: WMIC is removed from current Windows releases, while WMI/CIM can be
  // slow or unavailable on otherwise healthy machines. typeperf reads the
  // built-in process counters without WMI and includes the PID, parent PID,
  // and working set needed for subtree attribution. CIM remains a locale-
  // independent fallback when localized counter names make typeperf fail.
  if (windowsProcessBackend === 'typeperf') {
    const typeperfRows = await enumerateWindowsWithTypeperf()
    if (typeperfRows.length > 0) {
      return typeperfRows
    }
    // Counter names are localized on some Windows installations. Once the
    // probe fails, avoid spawning and warning about it on every two-second
    // Resource Manager poll; CIM remains the backend until app restart.
    windowsProcessBackend = 'cim'
  }
  return enumerateWindowsWithCim()
}

async function enumerateWindowsCpuSample(): Promise<WindowsCpuSample | null> {
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Get-Process | ForEach-Object { try { [string]::Join([char]9, @($_.Id, $_.TotalProcessorTime.Ticks, $_.StartTime.Ticks)) } catch {} }'
  ]
  try {
    const stdout = await execFileText('powershell.exe', args)
    return { sampledAtMs: performance.now(), byPid: parseWindowsCpuOutput(stdout) }
  } catch (err) {
    console.warn('[memory] PowerShell CPU sampling failed', err)
    return null
  }
}

function parseWindowsCpuOutput(stdout: string): Map<number, WindowsCpuTimes> {
  const byPid = new Map<number, WindowsCpuTimes>()
  for (const line of iterateProcessOutputLines(stdout)) {
    const fields = getProcessOutputFields(line, 3)
    if (fields.length < 3) {
      continue
    }
    const pid = Number.parseInt(fields[0], 10)
    const cpuTicks = Number.parseInt(fields[1], 10)
    const startTimeId = fields[2]
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      !Number.isSafeInteger(cpuTicks) ||
      cpuTicks < 0 ||
      !/^\d+$/.test(startTimeId) ||
      /^0+$/.test(startTimeId)
    ) {
      continue
    }
    byPid.set(pid, { cpuTicks, startTimeId })
  }
  return byPid
}

async function enumerateWindowsWithTypeperf(): Promise<ProcRow[]> {
  try {
    // `-si 0` asks for the first sample immediately; the default one-second
    // interval would consume half of Resource Manager's two-second poll cycle.
    const stdout = await execFileText('typeperf.exe', [
      ...TYPEPERF_COUNTERS,
      '-sc',
      '1',
      '-si',
      '0'
    ])
    return parseTypeperfProcessOutput(stdout)
  } catch (err) {
    console.warn('[memory] typeperf process enumeration failed; falling back to CIM', err)
    return []
  }
}

async function enumerateWindowsWithCim(): Promise<ProcRow[]> {
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize | ForEach-Object { [string]::Join([char]9, @($_.ProcessId, $_.ParentProcessId, $_.WorkingSetSize)) }'
  ]
  try {
    const stdout = await execFileText('powershell.exe', args)
    return parseWindowsProcessOutput(stdout)
  } catch (err) {
    console.warn('[memory] PowerShell process enumeration failed', err)
    return []
  }
}

function execFileText(file: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: 'utf8',
        maxBuffer: PS_MAX_BUFFER,
        timeout: PS_EXEC_TIMEOUT_MS,
        windowsHide: true
      },
      (err, output) => {
        if (err) {
          reject(err)
          return
        }
        resolve(String(output))
      }
    )
  })
}

type TypeperfProcessFields = {
  pid?: number
  ppid?: number
  memory?: number
}

/** Exported for tests: parses one CSV sample from Windows `typeperf`. */
export function parseTypeperfProcessOutput(stdout: string): ProcRow[] {
  let headers: string[] | null = null
  let values: string[] | null = null

  for (const line of iterateProcessOutputLines(stdout)) {
    if (!line || line.length > TYPEPERF_MAX_LINE_CHARS) {
      continue
    }
    const fields = parseTypeperfCsvLine(line)
    if (!headers && fields[0]?.startsWith('(PDH-CSV')) {
      headers = fields
      continue
    }
    if (headers && fields.length === headers.length) {
      values = fields
      break
    }
  }

  if (!headers || !values) {
    return []
  }

  const byInstance = new Map<string, TypeperfProcessFields>()
  for (let index = 1; index < headers.length; index += 1) {
    const path = parseTypeperfCounterPath(headers[index])
    if (!path || path.instance === '_Total') {
      continue
    }
    const value = Number.parseFloat(values[index])
    if (!Number.isFinite(value)) {
      continue
    }
    const row = byInstance.get(path.instance) ?? {}
    if (path.counter === 'ID Process') {
      row.pid = Math.trunc(value)
    } else if (path.counter === 'Creating Process ID') {
      row.ppid = Math.trunc(value)
    } else if (path.counter === 'Working Set') {
      row.memory = value
    }
    byInstance.set(path.instance, row)
  }

  const rows: ProcRow[] = []
  for (const row of byInstance.values()) {
    if (row.pid === undefined || row.pid <= 0 || row.ppid === undefined || row.ppid < 0) {
      continue
    }
    rows.push({
      pid: row.pid,
      ppid: row.ppid,
      cpu: 0,
      memory: row.memory !== undefined && row.memory > 0 ? row.memory : 0
    })
  }
  return rows
}

function parseTypeperfCounterPath(path: string): { instance: string; counter: string } | null {
  const processStart = path.lastIndexOf('\\Process(')
  const counterStart = path.lastIndexOf(')\\')
  if (processStart < 0 || counterStart <= processStart + 9) {
    return null
  }
  return {
    instance: path.slice(processStart + 9, counterStart),
    counter: path.slice(counterStart + 2)
  }
}

function parseTypeperfCsvLine(line: string): string[] {
  const fields: string[] = []
  let value = ''
  let quoted = false

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"'
        index += 1
      } else {
        quoted = !quoted
      }
      continue
    }
    if (char === ',' && !quoted) {
      fields.push(value)
      value = ''
      if (fields.length >= TYPEPERF_MAX_FIELDS) {
        return []
      }
      continue
    }
    value += char
  }
  fields.push(value)
  return fields
}

/** Exported for tests: parses tab-delimited PowerShell CIM process rows. */
export function parseWindowsProcessOutput(stdout: string): ProcRow[] {
  const rows: ProcRow[] = []
  for (const line of iterateProcessOutputLines(stdout)) {
    const fields = getProcessOutputFields(line, 3)
    if (fields.length < 3) {
      continue
    }
    const pid = Number.parseInt(fields[0], 10)
    const ppid = Number.parseInt(fields[1], 10)
    const memory = Number.parseInt(fields[2], 10)
    if (Number.isNaN(pid) || pid <= 0 || Number.isNaN(ppid) || ppid < 0) {
      continue
    }
    rows.push({
      pid,
      ppid,
      cpu: 0,
      memory: Number.isFinite(memory) && memory > 0 ? memory : 0
    })
  }
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

function electronMetricMemoryBytes(
  proc: ReturnType<typeof app.getAppMetrics>[number],
  processIndex: ProcIndex
): number {
  const hostMemory = processIndex.byPid.get(proc.pid)?.memory
  if (typeof hostMemory === 'number' && Number.isFinite(hostMemory) && hostMemory > 0) {
    return hostMemory
  }
  // Why: on macOS, app.getAppMetrics().workingSetSize can include large shared
  // Chromium/Electron mappings. Prefer the host RSS sweep used elsewhere, but
  // keep workingSetSize as a fallback when the process disappears mid-snapshot.
  return clampNumber(proc.memory?.workingSetSize) * 1024
}

function bucketElectronMetrics(processIndex: ProcIndex): AppBucketsRaw {
  const main = { cpu: 0, memory: 0 }
  const renderer = { cpu: 0, memory: 0 }
  const other = { cpu: 0, memory: 0 }

  for (const proc of app.getAppMetrics()) {
    const cpu = clampNumber(proc.cpu?.percentCPUUsage)
    const memoryBytes = electronMetricMemoryBytes(proc, processIndex)

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
  store: MemorySnapshotStore
): {
  worktreeName: string
  repoId: string
  repoName: string
} {
  // Orca worktree ids look like `${repoId}::${absolutePath}`.
  const parsed = splitWorktreeIdForFilesystem(worktreeId)
  const repoId = parsed?.repoId ?? worktreeId
  const worktreePath = parsed?.worktreePath ?? ''
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

async function runSnapshot(store: MemorySnapshotStore): Promise<MemorySnapshot> {
  const processIndex = await enumerateProcesses()
  const appBuckets = bucketElectronMetrics(processIndex)
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
