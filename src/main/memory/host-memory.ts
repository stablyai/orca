import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { HostAvailableMemorySource, HostMemory } from '../../shared/process-stats-types'

const KIB = 1024

let linuxAvailabilitySupported = true

export async function collectHostMemory(): Promise<HostMemory> {
  const total = nonNegativeNumber(os.totalmem())
  const free = Math.min(total, nonNegativeNumber(os.freemem()))
  // macOS memory_pressure includes occupied pageable RAM, not physically available bytes.
  const preferred = await readAvailableMemory(os.platform())
  const available = Math.min(total, Math.max(free, preferred?.bytes ?? free))
  const used = Math.max(0, total - available)

  return {
    totalMemory: total,
    freeMemory: free,
    availableMemory: available,
    availableMemorySource: preferred?.source ?? 'free-memory',
    usedMemory: used,
    memoryUsagePercent: total > 0 ? (used / total) * 100 : 0,
    cpuCoreCount: Math.max(1, os.cpus().length),
    loadAverage1m: nonNegativeNumber(os.loadavg()[0])
  }
}

export function fallbackHostMemory(): HostMemory {
  const total = nonNegativeNumber(os.totalmem())
  const free = Math.min(total, nonNegativeNumber(os.freemem()))
  const used = Math.max(0, total - free)
  return {
    totalMemory: total,
    freeMemory: free,
    availableMemory: free,
    availableMemorySource: 'free-memory',
    usedMemory: used,
    memoryUsagePercent: total > 0 ? (used / total) * 100 : 0,
    cpuCoreCount: Math.max(1, os.cpus().length),
    loadAverage1m: nonNegativeNumber(os.loadavg()[0])
  }
}

export function parseLinuxAvailableMemory(meminfo: string): number | null {
  const match = /^MemAvailable:\s*(\d+)\s+kB$/m.exec(meminfo)
  const kib = Number.parseInt(match?.[1] ?? '', 10)
  if (!Number.isSafeInteger(kib) || kib < 0 || kib > Number.MAX_SAFE_INTEGER / KIB) {
    return null
  }
  return kib * KIB
}

async function readAvailableMemory(
  platform: NodeJS.Platform
): Promise<{ bytes: number; source: HostAvailableMemorySource } | null> {
  if (platform === 'linux' && linuxAvailabilitySupported) {
    const bytes = await readLinuxAvailableMemory()
    if (bytes !== null) {
      return { bytes, source: 'proc-meminfo' }
    }
  }
  return null
}

async function readLinuxAvailableMemory(): Promise<number | null> {
  try {
    const meminfo = await readFile(path.join(path.sep, 'proc', 'meminfo'), 'utf8')
    const available = parseLinuxAvailableMemory(meminfo)
    if (available !== null) {
      return available
    }
  } catch {
    // Non-procfs Linux hosts use Node's memory value.
  }
  linuxAvailabilitySupported = false
  return null
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}
