import type { CrashReportDetailValue } from '../../shared/crash-reporting'
import type { SwapVolumeFreeSpace } from './swap-volume-free-space'

// Post-exit memory can look healthier; pre-gone samples retain earlier pressure evidence.

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

/** Describes the evidence this platform supplies, without inferring unmeasured pressure. */
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

// Windows SwapTotal is the commit limit; compare it with RAM to detect the hard-capped case.
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

/** Only co-timed volume reads qualify the current commit label. */
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
