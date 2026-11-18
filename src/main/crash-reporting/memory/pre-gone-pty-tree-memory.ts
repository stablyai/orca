import type { CrashReportDetailValue } from '../../../shared/crash-reporting/crash-reporting'
import { enumerateHostProcesses } from '../../memory/host-process-index'
import { getLocalDaemonPid } from '../../memory/local-daemon-pid'
import { collectSubtree, type ProcIndex, type ProcRow } from '../../memory/process-index'
import { claimPtyProcessTrees } from '../../memory/pty-process-trees'
import { listRegisteredPtys, type PtyRegistration } from '../../memory/pty-registry'
import { SYSTEM_MEMORY_KEY_PREFIX } from './system-memory-details'

// Why: app.getAppMetrics() cannot see PTY children (agents, shells), which can own the
// commit an OOM exhausts. A host sweep spawns ps/PowerShell, so it runs only in a pressure
// episode, and within one only at new lows: a bounded handful per episode, none on a plateau.

type CrashReportDetails = Record<string, CrashReportDetailValue>

export const PTY_TREE_MEMORY_MIN_SAMPLE_INTERVAL_MS = 30_000
const MAX_FAILURE_BACKOFF_MS = 5 * 60_000
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
  lastAttemptAtMs: number | null
  consecutiveFailures: number
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
  episode ??= { sweptLowMB: null, lastAttemptAtMs: null, consecutiveFailures: 0 }
  return headroom.headroomMB
}

function sweepDue(current: PressureEpisode, headroomMB: number, nowMs: number): boolean {
  if (headroomMB < MIN_HEADROOM_TO_SAMPLE_MB) {
    return false
  }
  if (current.lastAttemptAtMs !== null) {
    const backoffMs = Math.min(
      MAX_FAILURE_BACKOFF_MS,
      PTY_TREE_MEMORY_MIN_SAMPLE_INTERVAL_MS * 2 ** current.consecutiveFailures
    )
    if (nowMs - current.lastAttemptAtMs < backoffMs) {
      return false
    }
  }
  if (current.sweptLowMB === null) {
    return true
  }
  const step = Math.min(HEADROOM_DROP_MAX_MB, current.sweptLowMB * HEADROOM_DROP_FRACTION)
  return headroomMB <= current.sweptLowMB - step
}

/** Called with each host sample; sweeps once per pressure episode, then only at new lows. */
export function notePreGoneHostMemorySample(
  hostDetails: CrashReportDetails,
  nowMs: number,
  platform: NodeJS.Platform = process.platform
): void {
  const headroomMB = trackEpisode(hostDetails, platform)
  const current = episode
  if (inFlight || headroomMB === null || !current || !sweepDue(current, headroomMB, nowMs)) {
    return
  }
  // Capture what to attribute now: a PTY closing mid-sweep must not erase its evidence.
  const ptys = listRegisteredPtys().filter((pty) => pty.pid != null)
  if (ptys.length === 0) {
    return
  }
  const daemonPid = getLocalDaemonPid()
  current.lastAttemptAtMs = nowMs
  inFlight = true
  const startedGeneration = generation
  // Skip CPU: it would reset the resource view's CPU baseline.
  void enumerateHostProcesses({ trackCpu: false })
    .then((index) => {
      if (startedGeneration !== generation) {
        return
      }
      if (index.byPid.size === 0) {
        current.consecutiveFailures += 1
        return
      }
      sample = { details: summarizePtyTreeMemory(index, ptys, daemonPid), sampledAtMs: nowMs }
      current.sweptLowMB = headroomMB
      current.consecutiveFailures = 0
    })
    .catch(() => {
      // Keep the earlier sample; a failed sweep proves nothing about the tree.
      current.consecutiveFailures += 1
    })
    .finally(() => {
      if (startedGeneration === generation) {
        inFlight = false
      }
    })
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

function summarizePtyTreeMemory(
  index: ProcIndex,
  ptys: readonly PtyRegistration[],
  daemonPid: number | null
): CrashReportDetails {
  const rows: ProcRow[] = claimPtyProcessTrees(index, ptys).flatMap((tree) => tree.rows)
  const details: CrashReportDetails = {
    [`${KEY_PREFIX}PtyCount`]: ptys.length,
    [`${KEY_PREFIX}ProcessCount`]: rows.length,
    [`${KEY_PREFIX}MemoryMetric`]: index.memoryMetric
  }
  addMemoryDetails(details, '', sumMemory(rows))
  // getAppMetrics omits the detached daemon. Its other descendants (console hosts, PTYs
  // the registry could not attribute) are reported apart so they never read as daemon memory.
  if (daemonPid !== null) {
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
  const rank = (row: ProcRow): number => row.privateMemory ?? row.memory
  const top = [...rows].sort((a, b) => rank(b) - rank(a)).slice(0, TOP_PROCESS_COUNT)
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
  inFlight = false
  // Invalidate pending sweeps so they cannot repopulate a reset sample.
  generation += 1
}
