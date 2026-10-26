import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
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
import { readDarwinProcessFootprints } from './darwin-process-footprint'
import { getLocalDaemonPid } from './local-daemon-pid'
import {
  buildProcessIndex,
  collectSubtree,
  parsePsOutput,
  type ProcIndex,
  type ProcRow
} from './process-index'
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
export { collectSubtree, parsePsOutput } from './process-index'

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

async function enumerateProcesses(): Promise<ProcIndex> {
  const platform = os.platform()
  const [rows, footprints] = await Promise.all([
    platform === 'win32' ? enumerateWindows() : enumerateUnix(),
    platform === 'darwin' ? readDarwinProcessFootprints() : Promise.resolve(null)
  ])
  return buildProcessIndex(rows, footprints, getProcessMemoryMetric(platform))
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

async function enumerateWindows(): Promise<ProcRow[]> {
  return enumerateWindowsProcessResources()
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

  const electronPids = new Set<number>()
  for (const proc of getAppEnvironment().getAppMetrics()) {
    electronPids.add(proc.pid)
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

  // The terminal daemon is detached from Electron, so getAppMetrics omits it; its PTY children stay with their worktrees.
  const daemonPid = getLocalDaemonPid()
  const daemon = daemonPid === null ? undefined : processIndex.byPid.get(daemonPid)
  if (daemon && !electronPids.has(daemon.pid)) {
    other.cpu += daemon.cpu
    other.memory += daemon.memory
    other.privateMemory += clampMemoryMetric(daemon.privateMemory)
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
    processMemoryMetric: processIndex.memoryMetric,
    ...snapshotCommitFields(
      processIndex.hasPrivateMemory,
      clampMemoryMetric(appBuckets.privateMemory) + sessionPrivateTotal
    ),
    totalCpu: appBuckets.cpu + sessionCpuTotal,
    totalMemory: appBuckets.memory + sessionMemoryTotal,
    collectedAt: now
  }
}
