import type { CrashReportDetailValue } from '../../shared/crash-reporting'
import type { SwapVolumeFreeSpace } from './swap-volume-free-space'
import {
  cgroupMemoryBytesToMB,
  readLinuxCgroupMemoryLimit,
  type LinuxCgroupMemoryLimit
} from './linux-cgroup-memory-limit'
import {
  MEMORY_STALL_HIGH_AVG10_PERCENT,
  readLinuxMemoryPressureStall,
  type MemoryStallAverages
} from './linux-memory-pressure-stall'

// ─── Host system memory for crash reports ───────────────────────────
// Why: the system outlives the crashed process, so this IS sampleable at
// process-gone — it separates "renderer grew huge" from "machine out of
// memory/commit", which the per-process buckets alone cannot. The gone-time
// caller reads AFTER the corpse returned its pages, so free/swapFree read
// healthier than at kill time; the pre-gone sampler carries a live reading past
// that.
// Every reading is labelled `systemMemoryPressureSignal` so no report can be
// read as a pressure verdict the platform never gave:
//   win32  — swapFree is MEMORYSTATUSEX.ullAvailPageFile, i.e. available
//     COMMIT, which pagefile growth can heal (a 127 MB commit floor healed to
//     2029 MB mid-hold on the win-lowspec repro, killing nothing). Free space on
//     the swap volume does NOT establish that it could: a fixed-size or disabled
//     pagefile grows into no amount of empty disk, its maximum is unreadable
//     here (needs a registry read), and the measured volume is only the DEFAULT
//     pagefile drive. So a co-timed volume reading is context beside the commit
//     number — `available-commit-volume-cotimed` — never a verdict. The one
//     decisive win32 case is a commit limit at or below RAM: no pagefile exists
//     to grow, so the floor cannot heal (`available-commit-hard-capped`).
//   linux  — MemAvailable is the real signal; MemFree is not (it excludes page
//     cache and other reclaimable memory). But it is host-wide and knows nothing
//     about the cgroup we run in, nor about PSI stall, so on its own it cannot
//     tell a cgroup OOM or a systemd-oomd kill from an outside `kill -9`. Both
//     of those readings ship beside it and refine the label into
//     `mem-available-cgroup-capped` / `mem-available-stalled` — the family
//     prefix is kept so a reader matching the old exact value at worst loses the
//     refinement (docs/reference/linux-memory-kill-attribution.md).
//   darwin — none. `free` stays low on healthy machines and
//     fileBacked/purgeable are only a reclaimability proxy. The real signal
//     needs `memory_pressure -Q`; Orca's reader for it
//     (src/main/memory/host-memory.ts) is on-demand, and spawning a subprocess
//     on a 10 s app-lifetime timer costs more than the gap it closes.

type CrashReportDetails = Record<string, CrashReportDetailValue>

export const SYSTEM_MEMORY_KEY_PREFIX = 'systemMemory'

export function memoryKBFieldMB(value: unknown): number | undefined {
  const kb = typeof value === 'number' && Number.isFinite(value) ? value : undefined
  return kb === undefined ? undefined : Math.round(Math.max(0, kb) / 1024)
}

type SystemMemoryInfoLike = {
  total?: unknown
  free?: unknown
  available?: unknown
  swapTotal?: unknown
  swapFree?: unknown
  fileBacked?: unknown
  purgeable?: unknown
}

type SystemMemoryInfoReader = () => SystemMemoryInfoLike | null

/** How far this reading may be read as a "was the host under pressure" verdict. */
export type SystemMemoryPressureSignal =
  | 'available-commit-hard-capped'
  | 'available-commit-volume-cotimed'
  | 'available-commit-unqualified'
  | 'mem-available'
  | 'mem-available-cgroup-capped'
  | 'mem-available-stalled'
  | 'none'

function readElectronSystemMemoryInfo(): SystemMemoryInfoLike | null {
  const read = (process as NodeJS.Process & { getSystemMemoryInfo?: () => SystemMemoryInfoLike })
    .getSystemMemoryInfo
  if (typeof read !== 'function') {
    return null
  }
  try {
    return read.call(process)
  } catch {
    return null
  }
}

let systemMemoryInfoReader: SystemMemoryInfoReader = readElectronSystemMemoryInfo

export function setSystemMemoryInfoReaderForTest(reader: SystemMemoryInfoReader | null): void {
  systemMemoryInfoReader = reader ?? readElectronSystemMemoryInfo
}

function numericDetail(details: CrashReportDetails, suffix: string): number | undefined {
  const value = details[`${SYSTEM_MEMORY_KEY_PREFIX}${suffix}`]
  return typeof value === 'number' ? value : undefined
}

/** Windows commit limit = RAM + pagefile, so a limit at or below RAM has no pagefile behind it. */
function pagefileBacksCommit(details: CrashReportDetails): boolean | undefined {
  const total = numericDetail(details, 'TotalMB')
  const swapTotal = numericDetail(details, 'SwapTotalMB')
  return total === undefined || swapTotal === undefined ? undefined : swapTotal > total
}

function pressureSignal(
  platform: NodeJS.Platform,
  details: CrashReportDetails,
  volumeCoTimed = true
): SystemMemoryPressureSignal {
  if (platform === 'win32' && `${SYSTEM_MEMORY_KEY_PREFIX}SwapFreeMB` in details) {
    if (pagefileBacksCommit(details) === false) {
      return 'available-commit-hard-capped'
    }
    return volumeCoTimed && `${SYSTEM_MEMORY_KEY_PREFIX}SwapVolumeFreeMB` in details
      ? 'available-commit-volume-cotimed'
      : 'available-commit-unqualified'
  }
  if (platform === 'linux' && `${SYSTEM_MEMORY_KEY_PREFIX}AvailableMB` in details) {
    return linuxMemAvailableSignal(details)
  }
  return 'none'
}

/** A cgroup ceiling under host RAM can kill us with MemAvailable still in the gigabytes. */
function cgroupCeilingBelowHostRam(details: CrashReportDetails): boolean {
  const ceilings = [numericDetail(details, 'CgroupMaxMB'), numericDetail(details, 'CgroupHighMB')]
  const lowest = Math.min(...ceilings.filter((value) => value !== undefined))
  if (!Number.isFinite(lowest)) {
    return false
  }
  const total = numericDetail(details, 'TotalMB')
  return total === undefined || lowest < total
}

/** Our own cgroup's stall is nearest the kill; a busy host with a calm cgroup is a sibling's. */
function stallIsHigh(details: CrashReportDetails): boolean {
  const fullAvg10 =
    numericDetail(details, 'CgroupStallFullAvg10Pct') ?? numericDetail(details, 'StallFullAvg10Pct')
  return fullAvg10 !== undefined && fullAvg10 >= MEMORY_STALL_HIGH_AVG10_PERCENT
}

/**
 * A ceiling outranks stall because it explains the stall as well as the kill,
 * and the stall numbers stay readable in their own fields either way.
 */
function linuxMemAvailableSignal(details: CrashReportDetails): SystemMemoryPressureSignal {
  if (cgroupCeilingBelowHostRam(details)) {
    return 'mem-available-cgroup-capped'
  }
  return stallIsHigh(details) ? 'mem-available-stalled' : 'mem-available'
}

function addHostMemoryDetails(
  details: CrashReportDetails,
  info: SystemMemoryInfoLike | null
): void {
  if (!info) {
    return
  }
  const fields: readonly [keyof SystemMemoryInfoLike, string][] = [
    ['total', 'TotalMB'],
    ['free', 'FreeMB'],
    ['available', 'AvailableMB'],
    ['swapTotal', 'SwapTotalMB'],
    ['swapFree', 'SwapFreeMB'],
    ['fileBacked', 'FileBackedMB'],
    ['purgeable', 'PurgeableMB']
  ]
  for (const [field, suffix] of fields) {
    const mb = memoryKBFieldMB(info[field])
    if (mb !== undefined) {
      details[`${SYSTEM_MEMORY_KEY_PREFIX}${suffix}`] = mb
    }
  }
}

/** The numeric members only — the chain flag is a boolean and ships on its own. */
type LinuxCgroupMemoryNumberField = {
  [K in keyof LinuxCgroupMemoryLimit]-?: NonNullable<LinuxCgroupMemoryLimit[K]> extends number
    ? K
    : never
}[keyof LinuxCgroupMemoryLimit]

function addLinuxCgroupMemoryDetails(details: CrashReportDetails, platform: NodeJS.Platform): void {
  const cgroup = readLinuxCgroupMemoryLimit(platform)
  if (!cgroup) {
    return
  }
  const byteFields: readonly [LinuxCgroupMemoryNumberField, string][] = [
    ['maxBytes', 'CgroupMaxMB'],
    ['highBytes', 'CgroupHighMB'],
    ['currentBytes', 'CgroupCurrentMB'],
    ['ceilingCurrentBytes', 'CgroupCeilingCurrentMB']
  ]
  for (const [field, suffix] of byteFields) {
    const mb = cgroupMemoryBytesToMB(cgroup[field])
    if (mb !== undefined) {
      details[`${SYSTEM_MEMORY_KEY_PREFIX}${suffix}`] = mb
    }
  }
  const countFields: readonly [LinuxCgroupMemoryNumberField, string][] = [
    ['oomKillCount', 'CgroupOomKillCount'],
    ['maxEventCount', 'CgroupMaxEventCount'],
    ['highEventCount', 'CgroupHighEventCount']
  ]
  for (const [field, suffix] of countFields) {
    const count = cgroup[field]
    if (count !== undefined) {
      details[`${SYSTEM_MEMORY_KEY_PREFIX}${suffix}`] = count
    }
  }
  // Without this an absent ceiling reads as "uncapped" even when the chain we
  // walked stopped at a namespace root and the binding ceiling is above it.
  if (cgroup.chainReachesRoot !== undefined) {
    details[`${SYSTEM_MEMORY_KEY_PREFIX}CgroupChainReachesRoot`] = cgroup.chainReachesRoot
  }
}

function addMemoryStallDetails(
  details: CrashReportDetails,
  stall: MemoryStallAverages | undefined,
  scope: '' | 'Cgroup'
): void {
  if (!stall) {
    return
  }
  const fields: readonly [keyof MemoryStallAverages, string][] = [
    ['someAvg10', 'StallSomeAvg10Pct'],
    ['someAvg60', 'StallSomeAvg60Pct'],
    ['fullAvg10', 'StallFullAvg10Pct'],
    ['fullAvg60', 'StallFullAvg60Pct']
  ]
  for (const [field, suffix] of fields) {
    const percent = stall[field]
    if (percent !== undefined) {
      details[`${SYSTEM_MEMORY_KEY_PREFIX}${scope}${suffix}`] = percent
    }
  }
}

export function getSystemMemoryDetails(
  platform: NodeJS.Platform = process.platform
): CrashReportDetails {
  const details: CrashReportDetails = {}
  // Why not an early return when this reader fails: the cgroup and PSI readings
  // below are independent of it and are the ones that attribute a Linux SIGKILL.
  addHostMemoryDetails(details, systemMemoryInfoReader())
  addLinuxCgroupMemoryDetails(details, platform)
  const stall = readLinuxMemoryPressureStall(platform)
  addMemoryStallDetails(details, stall?.host, '')
  addMemoryStallDetails(details, stall?.cgroup, 'Cgroup')
  // Why not label an empty reading: a lone `PressureSignal` key would claim a
  // verdict about a host nothing here managed to measure.
  if (Object.keys(details).length === 0) {
    return {}
  }
  details[`${SYSTEM_MEMORY_KEY_PREFIX}PressureSignal`] = pressureSignal(platform, details)
  return details
}

/**
 * Merges the statfs-derived volume datum, which needs an await and so is only
 * reachable from the periodic sampler, and relabels the reading it sits beside.
 *
 * `coTimed` false means the statfs outlived the tick that issued it, so this
 * volume number and the commit number beside it describe different moments —
 * during a pagefile-growth storm that is exactly when they diverge, and a
 * pre-storm 40 GB printed next to 200 MB of commit reads as "the pagefile had
 * room", the opposite conclusion. The datum still ships (with its own age), but
 * only a co-timed one is named in the label.
 */
export function withSwapVolumeFreeSpace(
  details: CrashReportDetails,
  volume: SwapVolumeFreeSpace,
  platform: NodeJS.Platform = process.platform,
  coTimed = true
): CrashReportDetails {
  const merged: CrashReportDetails = {
    ...details,
    [`${SYSTEM_MEMORY_KEY_PREFIX}SwapVolumeFreeMB`]: volume.freeMB,
    [`${SYSTEM_MEMORY_KEY_PREFIX}SwapVolume`]: volume.volume
  }
  merged[`${SYSTEM_MEMORY_KEY_PREFIX}PressureSignal`] = pressureSignal(platform, merged, coTimed)
  return merged
}
