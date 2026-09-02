import type { CrashReportDetailValue } from '../../shared/crash-reporting'

// ─── System memory at gone time ─────────────────────────────────────
// Why: the system outlives the crashed process, so this IS sampleable at
// process-gone — it separates "renderer grew huge" from "machine out of
// memory/commit", which the per-process buckets alone cannot.
// Timing honesty: this reads AFTER the crashed process's memory returned to
// the OS, so free/swapFree can look healthier than they were at kill time.
// Platform honesty: swap* exist on Windows/Linux only. On Linux `free` is
// /proc/meminfo MemFree and is NOT the pressure signal — it excludes page cache
// and other reclaimable memory; `available` (MemAvailable, Linux-only) is. On
// macOS `free` is near-meaningless (file cache and compression keep it low on
// healthy machines); fileBacked/purgeable are the only reclaimability proxy this
// API gives there, and none of these fields answers "was the machine under
// pressure" on macOS — that needs a signal Electron does not expose.

type CrashReportDetails = Record<string, CrashReportDetailValue>

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

export function getSystemMemoryAtGoneDetails(): CrashReportDetails {
  const info = systemMemoryInfoReader()
  if (!info) {
    return {}
  }
  const details: CrashReportDetails = {}
  const fields: readonly [keyof SystemMemoryInfoLike, string][] = [
    ['total', 'systemMemoryTotalMB'],
    ['free', 'systemMemoryFreeMB'],
    ['available', 'systemMemoryAvailableMB'],
    ['swapTotal', 'systemMemorySwapTotalMB'],
    ['swapFree', 'systemMemorySwapFreeMB'],
    ['fileBacked', 'systemMemoryFileBackedMB'],
    ['purgeable', 'systemMemoryPurgeableMB']
  ]
  for (const [field, key] of fields) {
    const mb = memoryKBFieldMB(info[field])
    if (mb !== undefined) {
      details[key] = mb
    }
  }
  return details
}
