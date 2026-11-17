import type { CrashReportDetailValue } from '../../../shared/crash-reporting/crash-reporting'
import { enumerateHostProcesses } from '../../memory/host-process-index'
import { getLocalDaemonPid } from '../../memory/local-daemon-pid'
import type { ProcIndex, ProcRow } from '../../memory/process-index'
import { claimPtyProcessTrees } from '../../memory/pty-process-trees'
import { listRegisteredPtys } from '../../memory/pty-registry'
import { SYSTEM_MEMORY_KEY_PREFIX } from './system-memory-details'

// Why: app.getAppMetrics() cannot see PTY children (agents, shells), which can own the
// commit an OOM exhausts. A host sweep spawns ps/PowerShell, so it runs only under pressure.

type CrashReportDetails = Record<string, CrashReportDetailValue>

export const PTY_TREE_MEMORY_MIN_SAMPLE_INTERVAL_MS = 30_000
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
let lastStartedAtMs: number | null = null
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

function underPressure(details: CrashReportDetails, platform: NodeJS.Platform): boolean {
  const headroom = hostMemoryHeadroom(details, platform)
  if (!headroom || headroom.headroomMB < MIN_HEADROOM_TO_SAMPLE_MB) {
    return false
  }
  return (
    headroom.headroomMB <
    Math.min(PRESSURE_HEADROOM_MAX_MB, headroom.limitMB * PRESSURE_HEADROOM_FRACTION)
  )
}

/** Called with each committed host sample; starts at most one sweep per interval, under pressure. */
export function notePreGoneHostMemorySample(
  hostDetails: CrashReportDetails,
  nowMs: number,
  platform: NodeJS.Platform = process.platform
): void {
  const sampledRecently =
    lastStartedAtMs !== null && nowMs - lastStartedAtMs < PTY_TREE_MEMORY_MIN_SAMPLE_INTERVAL_MS
  if (inFlight || sampledRecently || !underPressure(hostDetails, platform)) {
    return
  }
  const ptys = listRegisteredPtys()
  if (!ptys.some((pty) => pty.pid != null)) {
    return
  }
  lastStartedAtMs = nowMs
  inFlight = true
  const startedGeneration = generation
  void enumerateHostProcesses()
    .then((index) => {
      if (startedGeneration === generation && index.byPid.size > 0) {
        sample = { details: summarizePtyTreeMemory(index), sampledAtMs: nowMs }
      }
    })
    .catch(() => {
      // Keep the earlier sample; a failed sweep proves nothing about the tree.
    })
    .finally(() => {
      if (startedGeneration === generation) {
        inFlight = false
      }
    })
}

const toMB = (bytes: number): number => Math.round(Math.max(0, bytes) / BYTES_PER_MB)

function summarizePtyTreeMemory(index: ProcIndex): CrashReportDetails {
  const ptys = listRegisteredPtys()
  const rows: ProcRow[] = claimPtyProcessTrees(index, ptys).flatMap((tree) => tree.rows)
  let memory = 0
  let commit = 0
  for (const row of rows) {
    memory += row.memory
    commit += row.privateMemory ?? 0
  }
  const details: CrashReportDetails = {
    [`${KEY_PREFIX}PtyCount`]: ptys.length,
    [`${KEY_PREFIX}ProcessCount`]: rows.length,
    [`${KEY_PREFIX}MemoryMetric`]: index.memoryMetric,
    [`${KEY_PREFIX}MemoryMB`]: toMB(memory)
  }
  if (index.hasPrivateMemory) {
    details[`${KEY_PREFIX}CommitMB`] = toMB(commit)
  }
  // The detached terminal daemon parents every PTY and is also invisible to getAppMetrics.
  const daemonPid = getLocalDaemonPid()
  const daemon = daemonPid === null ? undefined : index.byPid.get(daemonPid)
  if (daemon) {
    details[`${KEY_PREFIX}DaemonMemoryMB`] = toMB(daemon.memory)
    if (daemon.privateMemory !== undefined) {
      details[`${KEY_PREFIX}DaemonCommitMB`] = toMB(daemon.privateMemory)
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
  lastStartedAtMs = null
  inFlight = false
  // Invalidate pending sweeps so they cannot repopulate a reset sample.
  generation += 1
}
