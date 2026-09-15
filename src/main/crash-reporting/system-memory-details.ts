import type { CrashReportDetailValue } from '../../shared/crash-reporting'
import type { SwapVolumeFreeSpace } from './swap-volume-free-space'

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
//     cache and other reclaimable memory).
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
    return 'mem-available'
  }
  return 'none'
}

export function getSystemMemoryDetails(
  platform: NodeJS.Platform = process.platform
): CrashReportDetails {
  const info = systemMemoryInfoReader()
  if (!info) {
    return {}
  }
  const details: CrashReportDetails = {}
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
