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
  type MemorySnapshotStore,
  type WorktreeMemoryBucket
} from './memory-snapshot-buckets'
import {
  clampMemoryMetric,
  emptyMemorySnapshot,
  optionalCommitField,
  snapshotCommitFields
} from './memory-snapshot-values'

export type { MemorySnapshotStore } from './memory-snapshot-buckets'

let inflight: Promise<MemorySnapshot> | null = null

export async function collectMemorySnapshot(store: MemorySnapshotStore): Promise<MemorySnapshot> {
  // Runtime callers share one process-wide store, so coalesced sweeps use the same data source.
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

const execAsync = promisify(exec)
const PS_EXEC_TIMEOUT_MS = 5_000
const PS_MAX_BUFFER = 10 * 1024 * 1024

type ProcRow = {
  pid: number
  ppid: number
  /** Percent of one core; may exceed 100 across cores. */
  cpu: number
  /** Resident memory in bytes. */
  memory: number
  /** Committed bytes, including paged-out memory; absent when unavailable. */
  privateMemory?: number
}

type ProcIndex = {
  byPid: Map<number, ProcRow>
  childrenOf: Map<number, number[]>
  /** Missing commit counters must not look like measured zero. */
  hasPrivateMemory: boolean
}

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
  // Force dot decimals: parseFloat silently truncates locale-formatted comma values.
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
export function collectSubtree(
  index: ProcIndex,
  root: number,
  excludedPids?: ReadonlySet<number>
): number[] {
  const result: number[] = []
  const seen = new Set<number>()
  const queue = [root]
  while (queue.length > 0) {
    const pid = queue.pop()
    if (pid === undefined) {
      break
    }
    // Earlier PTYs already claimed excluded subtrees; skip their descendants to avoid repeated walks.
    if (seen.has(pid) || excludedPids?.has(pid)) {
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

type AppBucketsRaw = Omit<AppMemory, 'history'>

function electronMetricMemoryBytes(
  proc: ReturnType<AppEnvironment['getAppMetrics']>[number],
  processIndex: ProcIndex
): number {
  const hostMemory = processIndex.byPid.get(proc.pid)?.memory
  if (typeof hostMemory === 'number' && Number.isFinite(hostMemory) && hostMemory > 0) {
    return hostMemory
  }
  // Prefer host RSS over shared macOS Electron mappings; retain Electron fallback for vanished processes.
  return clampMemoryMetric(proc.memory?.workingSetSize) * 1024
}

function bucketElectronMetrics(processIndex: ProcIndex): AppBucketsRaw {
  const main = { cpu: 0, memory: 0, privateMemory: 0 }
  const renderer = { cpu: 0, memory: 0, privateMemory: 0 }
  const other = { cpu: 0, memory: 0, privateMemory: 0 }

  for (const proc of getAppEnvironment().getAppMetrics()) {
    const cpu = clampMemoryMetric(proc.cpu?.percentCPUUsage)
    const memoryBytes = electronMetricMemoryBytes(proc, processIndex)
    // Electron does not report helper-process commit; reuse the host sweep.
    const privateBytes = clampMemoryMetric(processIndex.byPid.get(proc.pid)?.privateMemory)

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

async function runSnapshot(store: MemorySnapshotStore): Promise<MemorySnapshot> {
  const [processIndex, host] = await Promise.all([enumerateProcesses(), collectHostMemory()])
  const appBuckets = bucketElectronMetrics(processIndex)
  const ptys = listRegisteredPtys()

  // Attribute overlapping PTY trees once, in registration order.
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
      for (const pid of collectSubtree(processIndex, pty.pid, claimed)) {
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

  // Write before reading history to include this sample and refresh active-worktree retention.
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
