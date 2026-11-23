import { performance } from 'node:perf_hooks'
import type { CrashReportDetailValue } from '../../../shared/crash-reporting/crash-reporting'
import { enumerateHostProcesses, readExecutableNames } from '../../memory/host-process-index'
import { getKnownLocalDaemonPid } from '../../memory/local-daemon-pid'
import { collectSubtree, type ProcIndex, type ProcRow } from '../../memory/process-index'
import { claimPtyProcessTrees } from '../../memory/pty-process-trees'
import {
  hasRegisteredPtyWithPid,
  listRegisteredPtys,
  type PtyRegistration
} from '../../memory/pty-registry'
import { SYSTEM_MEMORY_KEY_PREFIX } from './system-memory-details'

// Why: app.getAppMetrics() cannot see PTY children (agents, shells), which can own the
// commit an OOM exhausts. A host sweep spawns ps/PowerShell, so a pressure episode decides
// when one is useful (its start, then new lows) and a global token bucket caps how often.

type CrashReportDetails = Record<string, CrashReportDetailValue>

export const PTY_TREE_MEMORY_MIN_SAMPLE_INTERVAL_MS = 30_000
// At most 4 + 12 sweeps in any hour, 12/h sustained, failures included.
const SWEEP_TOKEN_CAPACITY = 4
const SWEEP_TOKEN_REFILL_MS = 5 * 60_000
// A sweep that keeps failing then probes rarely instead of spending the budget.
const FAILURES_BEFORE_PROBING = 3
const FAILED_PROBE_INTERVAL_MS = 30 * 60_000
const HEADROOM_DROP_MAX_MB = 512
const HEADROOM_DROP_FRACTION = 0.25
// An episode ends only this far above the threshold, so hovering at it is one episode.
const EPISODE_END_MARGIN_MB = 512
const PRESSURE_HEADROOM_MAX_MB = 4096
const PRESSURE_HEADROOM_FRACTION = 0.2
// Below this, spawning PowerShell could itself tip the host over; keep the earlier sample.
const MIN_HEADROOM_TO_SAMPLE_MB = 256
const TOP_PROCESS_COUNT = 3
const BYTES_PER_MB = 1024 * 1024
const KEY_PREFIX = 'ptyTreeMemoryPreGone'

type PtyTreeMemorySample = {
  details: CrashReportDetails
  sampledAtMs: number
}

let sample: PtyTreeMemorySample | null = null
type PressureEpisode = {
  /** Headroom at the last stored sweep; null until one succeeds. */
  sweptLowMB: number | null
}

// Admission state outlives episodes, so re-entering pressure cannot reset it.
// Tokens are held as milliseconds of refill time so admission is exact integer math.
const FULL_BUCKET_MS = SWEEP_TOKEN_CAPACITY * SWEEP_TOKEN_REFILL_MS
const admission: {
  bucketMs: number
  refilledAtMs: number | null
  lastAttemptAtMs: number | null
  consecutiveFailures: number
} = {
  bucketMs: FULL_BUCKET_MS,
  refilledAtMs: null,
  lastAttemptAtMs: null,
  consecutiveFailures: 0
}

let episode: PressureEpisode | null = null
let inFlight = false
let generation = 0

function hostDetail(details: CrashReportDetails, suffix: string): number | undefined {
  const value = details[`${SYSTEM_MEMORY_KEY_PREFIX}${suffix}`]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Memory the host can still hand out: Windows commit, Linux MemAvailable, macOS free + reclaimable. */
export function hostMemoryHeadroom(
  details: CrashReportDetails,
  platform: NodeJS.Platform
): { headroomMB: number; limitMB: number } | null {
  if (platform === 'win32') {
    const headroomMB = hostDetail(details, 'SwapFreeMB')
    const limitMB = hostDetail(details, 'SwapTotalMB')
    return headroomMB === undefined || limitMB === undefined ? null : { headroomMB, limitMB }
  }
  const limitMB = hostDetail(details, 'TotalMB')
  if (limitMB === undefined) {
    return null
  }
  if (platform === 'linux') {
    const headroomMB = hostDetail(details, 'AvailableMB')
    return headroomMB === undefined ? null : { headroomMB, limitMB }
  }
  const freeMB = hostDetail(details, 'FreeMB')
  if (freeMB === undefined) {
    return null
  }
  const reclaimableMB =
    (hostDetail(details, 'FileBackedMB') ?? 0) + (hostDetail(details, 'PurgeableMB') ?? 0)
  return { headroomMB: freeMB + reclaimableMB, limitMB }
}

function pressureThresholdMB(limitMB: number): number {
  return Math.min(PRESSURE_HEADROOM_MAX_MB, limitMB * PRESSURE_HEADROOM_FRACTION)
}

/** Open, keep or close the pressure episode; returns the headroom when in one. */
function trackEpisode(details: CrashReportDetails, platform: NodeJS.Platform): number | null {
  const headroom = hostMemoryHeadroom(details, platform)
  if (!headroom) {
    return null
  }
  const thresholdMB = pressureThresholdMB(headroom.limitMB)
  if (headroom.headroomMB >= thresholdMB + EPISODE_END_MARGIN_MB) {
    episode = null
    return null
  }
  if (!episode && headroom.headroomMB >= thresholdMB) {
    return null
  }
  episode ??= { sweptLowMB: null }
  return headroom.headroomMB
}

function sweepUseful(current: PressureEpisode, headroomMB: number): boolean {
  if (headroomMB < MIN_HEADROOM_TO_SAMPLE_MB) {
    return false
  }
  if (current.sweptLowMB === null) {
    return true
  }
  const step = Math.min(HEADROOM_DROP_MAX_MB, current.sweptLowMB * HEADROOM_DROP_FRACTION)
  return headroomMB <= current.sweptLowMB - step
}

function admitSweep(nowMs: number): boolean {
  if (admission.refilledAtMs !== null) {
    const elapsedMs = Math.max(0, nowMs - admission.refilledAtMs)
    admission.bucketMs = Math.min(FULL_BUCKET_MS, admission.bucketMs + elapsedMs)
  }
  admission.refilledAtMs = nowMs
  const sinceAttemptMs =
    admission.lastAttemptAtMs === null ? Infinity : nowMs - admission.lastAttemptAtMs
  const spacingMs =
    admission.consecutiveFailures >= FAILURES_BEFORE_PROBING
      ? FAILED_PROBE_INTERVAL_MS
      : PTY_TREE_MEMORY_MIN_SAMPLE_INTERVAL_MS
  if (sinceAttemptMs < spacingMs || admission.bucketMs < SWEEP_TOKEN_REFILL_MS) {
    return false
  }
  admission.bucketMs -= SWEEP_TOKEN_REFILL_MS
  admission.lastAttemptAtMs = nowMs
  return true
}

/** Called with each host sample; sweeps at an episode's start and new lows, within budget. */
export function notePreGoneHostMemorySample(
  hostDetails: CrashReportDetails,
  nowMs: number,
  platform: NodeJS.Platform = process.platform,
  // Admission spacing uses a monotonic clock so wall-clock changes cannot skip or stall it.
  monotonicMs: number = performance.now()
): void {
  const headroomMB = trackEpisode(hostDetails, platform)
  const current = episode
  if (
    inFlight ||
    headroomMB === null ||
    !current ||
    !sweepUseful(current, headroomMB) ||
    !hasRegisteredPtyWithPid() ||
    !admitSweep(monotonicMs)
  ) {
    return
  }
  // Capture what to attribute now: a PTY closing mid-sweep must not erase its evidence.
  const ptys = listRegisteredPtys().filter((pty) => pty.pid != null)
  const daemonPid = getKnownLocalDaemonPid()
  inFlight = true
  const startedGeneration = generation
  // Skip CPU: it would reset the resource view's CPU baseline.
  void collectPtyTreeMemory(ptys, daemonPid)
    .then((details) => {
      if (startedGeneration !== generation) {
        return
      }
      if (!details) {
        admission.consecutiveFailures += 1
        return
      }
      sample = { details, sampledAtMs: nowMs }
      current.sweptLowMB = headroomMB
      admission.consecutiveFailures = 0
    })
    .catch(() => {
      // Keep the earlier sample; a failed sweep proves nothing about the tree.
      if (startedGeneration === generation) {
        admission.consecutiveFailures += 1
      }
    })
    .finally(() => {
      if (startedGeneration === generation) {
        inFlight = false
      }
    })
}

async function collectPtyTreeMemory(
  ptys: readonly PtyRegistration[],
  daemonPid: number | null
): Promise<CrashReportDetails | null> {
  const index = await enumerateHostProcesses({ trackCpu: false, withNames: true })
  if (index.byPid.size === 0) {
    return null
  }
  const rows = claimPtyProcessTrees(index, ptys).flatMap((tree) => tree.rows)
  const top = topByCommit(rows)
  await readExecutableNames(top)
  return summarizePtyTreeMemory(index, ptys, daemonPid, rows, top)
}

const toMB = (bytes: number): number => Math.round(Math.max(0, bytes) / BYTES_PER_MB)

function sumMemory(rows: readonly ProcRow[]): { memory: number; commit: number | null } {
  let memory = 0
  let commit: number | null = 0
  for (const row of rows) {
    memory += row.memory
    // One unreadable counter makes the total unknown, not smaller.
    commit = commit === null || row.privateMemory === undefined ? null : commit + row.privateMemory
  }
  return { memory, commit }
}

function addMemoryDetails(
  details: CrashReportDetails,
  label: string,
  total: { memory: number; commit: number | null }
): void {
  details[`${KEY_PREFIX}${label}MemoryMB`] = toMB(total.memory)
  if (total.commit !== null) {
    details[`${KEY_PREFIX}${label}CommitMB`] = toMB(total.commit)
  }
}

/** One linear pass keeping the largest few; no sort of the whole tree. */
function topByCommit(rows: readonly ProcRow[]): ProcRow[] {
  const rank = (row: ProcRow): number => row.privateMemory ?? row.memory
  const top: ProcRow[] = []
  for (const row of rows) {
    let at = top.length
    while (at > 0 && rank(top[at - 1]) < rank(row)) {
      at -= 1
    }
    if (at < TOP_PROCESS_COUNT) {
      top.splice(at, 0, row)
      top.length = Math.min(top.length, TOP_PROCESS_COUNT)
    }
  }
  return top
}

function summarizePtyTreeMemory(
  index: ProcIndex,
  ptys: readonly PtyRegistration[],
  daemonPid: number | null,
  rows: readonly ProcRow[],
  top: readonly ProcRow[]
): CrashReportDetails {
  const details: CrashReportDetails = {
    [`${KEY_PREFIX}PtyCount`]: ptys.length,
    [`${KEY_PREFIX}ProcessCount`]: rows.length,
    [`${KEY_PREFIX}MemoryMetric`]: index.memoryMetric
  }
  addMemoryDetails(details, '', sumMemory(rows))
  // getAppMetrics omits the detached daemon. Its other descendants (console hosts, PTYs
  // the registry could not attribute) are reported apart so they never read as daemon memory.
  // The authenticated pid may be stale (restart, pid reuse): require it to parent a PTY root.
  // Windows keeps a dead parent's pid, so there it must also provably predate that root.
  const daemonStart = daemonPid === null ? undefined : index.byPid.get(daemonPid)?.startTicks
  const parentsPtyRoot =
    daemonPid !== null &&
    ptys.some((pty) => {
      const root = pty.pid == null ? undefined : index.byPid.get(pty.pid)
      if (root?.ppid !== daemonPid) {
        return false
      }
      if (process.platform !== 'win32') {
        return true
      }
      return (
        daemonStart !== undefined && root.startTicks !== undefined && daemonStart <= root.startTicks
      )
    })
  if (daemonPid !== null && parentsPtyRoot) {
    const daemonRow = index.byPid.get(daemonPid)
    if (daemonRow) {
      addMemoryDetails(details, 'Daemon', sumMemory([daemonRow]))
      const claimed = new Set(rows.map((row) => row.pid))
      const others = collectSubtree(index, daemonPid, claimed).flatMap((pid) =>
        pid === daemonPid ? [] : (index.byPid.get(pid) ?? [])
      )
      addMemoryDetails(details, 'Unattributed', sumMemory(others))
    }
  }
  top.forEach((row, i) => {
    const key = `${KEY_PREFIX}Top${i + 1}`
    details[`${key}Name`] = row.name ?? 'unknown'
    details[`${key}MemoryMB`] = toMB(row.memory)
    if (row.privateMemory !== undefined) {
      details[`${key}CommitMB`] = toMB(row.privateMemory)
    }
  })
  return details
}

export function preGonePtyTreeMemoryDetails(nowMs: number): CrashReportDetails {
  if (!sample) {
    return {}
  }
  return {
    [`${KEY_PREFIX}SampleAgeMs`]: Math.max(0, nowMs - sample.sampledAtMs),
    ...sample.details
  }
}

export function resetPreGonePtyTreeMemoryForTest(): void {
  sample = null
  episode = null
  admission.bucketMs = FULL_BUCKET_MS
  admission.refilledAtMs = null
  admission.lastAttemptAtMs = null
  admission.consecutiveFailures = 0
  inFlight = false
  // Invalidate pending sweeps so they cannot repopulate a reset sample.
  generation += 1
}
