/**
 * Memory dashboard collector.
 *
 * One snapshot covers two sources:
 *   - Orca's own Electron processes, via `getAppEnvironment().getAppMetrics()`, bucketed
 *     into main / renderer / other.
 *   - Each registered PTY's process subtree, enumerated once from a host-
 *     wide process sweep (PowerShell CIM with a Typeperf fallback on Windows).
 *
 * Memory samples are held in a per-key ring (one key per worktree, plus
 * a reserved app-total key) so the UI can draw a trend sparkline.
 *
 * Concurrent callers coalesce onto a single in-flight sweep so a burst of
 * renderer polls never produces overlapping child processes.
 */

import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import {
  getProcessOutputFields,
  iterateProcessOutputLines
} from '../../shared/process-output-field-scanner'
import { getAppEnvironment, type AppEnvironment } from '../../shared/app-environment'
import type {
  AppMemory,
  MemorySnapshot,
  SessionMemory,
  UsageValues,
  WorktreeMemory
} from '../../shared/process-stats-types'
import type { Store } from '../persistence'
import { ORPHAN_WORKTREE_ID } from '../../shared/constants'
import { listRegisteredPtys } from './pty-registry'
import { enumerateWindowsProcessResources } from './windows-process-resource-collector'
import { collectHostMemory } from './host-memory'
import { getProcessMemoryMetric } from './process-memory-metric'
import {
  createEmptyWorktreeMemoryBucket,
  pushAppMemoryHistory,
  pushMemoryHistorySample,
  readAppMemoryHistory,
  readMemoryHistory,
  resolveWorktreeMemoryNames,
  sweepStaleMemoryHistory,
  type WorktreeMemoryBucket
} from './memory-snapshot-buckets'
import {
  clampMemoryMetric,
  emptyMemorySnapshot,
  optionalCommitField,
  snapshotCommitFields
} from './memory-snapshot-values'

export type MemorySnapshotStore = Pick<Store, 'getRepo' | 'getWorktreeMeta'>

// ─── Module state ───────────────────────────────────────────────────

let inflight: Promise<MemorySnapshot> | null = null

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
      return emptyMemorySnapshot()
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
  /** Percent of one core (may exceed 100 on multi-core). */
  cpu: number
  /** Resident memory in bytes. */
  memory: number
  /** Committed bytes, resident or paged out. Absent when the host cannot report it. */
  privateMemory?: number
}

/** Indexed view of a single host process sweep. */
type ProcIndex = {
  byPid: Map<number, ProcRow>
  childrenOf: Map<number, number[]>
  /**
   * Whether this sweep reported committed bytes at all. Data-driven rather than
   * platform-driven: the Windows typeperf fallback can be missing the counter,
   * and reporting a 0 sum then would read as "agents commit nothing".
   */
  hasPrivateMemory: boolean
}

// ─── Host process enumeration ───────────────────────────────────────

async function enumerateProcesses(): Promise<ProcIndex> {
  const rows = os.platform() === 'win32' ? await enumerateWindows() : await enumerateUnix()

  const byPid = new Map<number, ProcRow>()
  const childrenOf = new Map<number, number[]>()
  let hasPrivateMemory = false

  for (const row of rows) {
    byPid.set(row.pid, row)
    hasPrivateMemory ||= row.privateMemory !== undefined
    const siblings = childrenOf.get(row.ppid)
    if (siblings) {
      siblings.push(row.pid)
    } else {
      childrenOf.set(row.ppid, [row.pid])
    }
  }

  return { byPid, childrenOf, hasPrivateMemory }
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
  return enumerateWindowsProcessResources()
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
  proc: ReturnType<AppEnvironment['getAppMetrics']>[number],
  processIndex: ProcIndex
): number {
  const hostMemory = processIndex.byPid.get(proc.pid)?.memory
  if (typeof hostMemory === 'number' && Number.isFinite(hostMemory) && hostMemory > 0) {
    return hostMemory
  }
  // Why: on macOS, getAppEnvironment().getAppMetrics().workingSetSize can include large shared
  // Chromium/Electron mappings. Prefer the host RSS sweep used elsewhere, but
  // keep workingSetSize as a fallback when the process disappears mid-snapshot.
  return clampMemoryMetric(proc.memory?.workingSetSize) * 1024
}

function bucketElectronMetrics(processIndex: ProcIndex): AppBucketsRaw {
  const main = { cpu: 0, memory: 0, privateMemory: 0 }
  const renderer = { cpu: 0, memory: 0, privateMemory: 0 }
  const other = { cpu: 0, memory: 0, privateMemory: 0 }

  for (const proc of getAppEnvironment().getAppMetrics()) {
    const cpu = clampMemoryMetric(proc.cpu?.percentCPUUsage)
    const memoryBytes = electronMetricMemoryBytes(proc, processIndex)
    // Why the host row rather than Electron's own metric: getAppMetrics has no
    // commit figure for helper processes, and the sweep already indexed them.
    const privateBytes = clampMemoryMetric(processIndex.byPid.get(proc.pid)?.privateMemory)

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
    target.privateMemory += privateBytes
  }

  const usage = (bucket: typeof main): UsageValues => ({
    cpu: bucket.cpu,
    memory: bucket.memory,
    ...optionalCommitField(processIndex.hasPrivateMemory, bucket.privateMemory)
  })

  return {
    main: usage(main),
    renderer: usage(renderer),
    other: usage(other),
    ...usage({
      cpu: main.cpu + renderer.cpu + other.cpu,
      memory: main.memory + renderer.memory + other.memory,
      privateMemory: main.privateMemory + renderer.privateMemory + other.privateMemory
    })
  }
}

// ─── Main collection path ───────────────────────────────────────────

async function runSnapshot(store: MemorySnapshotStore): Promise<MemorySnapshot> {
  const [processIndex, host] = await Promise.all([enumerateProcesses(), collectHostMemory()])
  const appBuckets = bucketElectronMetrics(processIndex)
  const ptys = listRegisteredPtys()

  // Why: when two PTYs share an ancestor in the process tree (e.g. a
  // supervisor, or a shell that re-execed), a naive walk would double-count
  // that ancestor's memory. Track which pids have already been claimed and
  // attribute to the first PTY (registration order) to see each pid.
  const claimed = new Set<number>()

  const orphan = createEmptyWorktreeMemoryBucket(
    ORPHAN_WORKTREE_ID,
    'Unattributed terminals',
    ORPHAN_WORKTREE_ID,
    'Other'
  )
  const worktreeBuckets = new Map<string, WorktreeMemoryBucket>()

  for (const pty of ptys) {
    let sessionCpu = 0
    let sessionMemory = 0
    let sessionPrivateMemory = 0

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
        // Why the whole subtree: an agent's committed bytes live in the
        // children it spawned (codex.exe, MCP servers), not in the shell.
        sessionPrivateMemory += clampMemoryMetric(row.privateMemory)
      }
    }

    const session: SessionMemory = {
      sessionId: pty.sessionId ?? pty.ptyId,
      paneKey: pty.paneKey,
      pid: pty.pid ?? 0,
      cpu: clampMemoryMetric(sessionCpu),
      memory: clampMemoryMetric(sessionMemory),
      ...optionalCommitField(processIndex.hasPrivateMemory, sessionPrivateMemory)
    }

    let bucket: WorktreeMemoryBucket
    if (pty.worktreeId) {
      const existing = worktreeBuckets.get(pty.worktreeId)
      if (existing) {
        bucket = existing
      } else {
        const names = resolveWorktreeMemoryNames(pty.worktreeId, store)
        bucket = createEmptyWorktreeMemoryBucket(
          pty.worktreeId,
          names.worktreeName,
          names.repoId,
          names.repoName
        )
        worktreeBuckets.set(pty.worktreeId, bucket)
      }
    } else {
      bucket = orphan
    }

    bucket.cpu += session.cpu
    bucket.memory += session.memory
    bucket.privateMemory += clampMemoryMetric(session.privateMemory)
    bucket.sessions.push(session)
  }

  const bucketList: WorktreeMemoryBucket[] = [...worktreeBuckets.values()]
  if (orphan.sessions.length > 0) {
    bucketList.push(orphan)
  }

  // Why: record this sweep's samples *before* reading back history, so the
  // returned arrays end with the freshly-collected value. Each write also
  // acts as a keep-alive so active worktrees survive the staleness sweep.
  const now = Date.now()
  pushAppMemoryHistory(appBuckets.memory, now)
  for (const bucket of bucketList) {
    pushMemoryHistorySample(bucket.worktreeId, bucket.memory, now)
  }
  sweepStaleMemoryHistory(now)

  const worktrees: WorktreeMemory[] = bucketList.map(({ privateMemory, ...b }) => ({
    ...b,
    ...optionalCommitField(processIndex.hasPrivateMemory, privateMemory),
    history: readMemoryHistory(b.worktreeId)
  }))

  let sessionCpuTotal = 0
  let sessionMemoryTotal = 0
  let sessionPrivateTotal = 0
  for (const wt of worktrees) {
    sessionCpuTotal += wt.cpu
    sessionMemoryTotal += wt.memory
    sessionPrivateTotal += clampMemoryMetric(wt.privateMemory)
  }

  return {
    app: { ...appBuckets, history: readAppMemoryHistory() },
    worktrees,
    host,
    processMemoryMetric: getProcessMemoryMetric(),
    ...snapshotCommitFields(
      processIndex.hasPrivateMemory,
      clampMemoryMetric(appBuckets.privateMemory) + sessionPrivateTotal
    ),
    totalCpu: appBuckets.cpu + sessionCpuTotal,
    totalMemory: appBuckets.memory + sessionMemoryTotal,
    collectedAt: now
  }
}
