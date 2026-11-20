import { runProcess } from '@orca/process-host'
import type { HostMemory } from '../../../shared/diagnostics/process-stats-types'
import {
  zotzSystemMemoryPressure,
  type ZotzMemoryPressure
} from '../../../shared/zotz/agent-queue/zotz-memory-pressure'

const SYSCTL_TIMEOUT_MS = 1_000
// Long enough to span several 15 s samples, short enough that old paging stops counting.
const SWAP_WINDOW_MS = 2 * 60_000

async function readCommand(program: string, args: string[]): Promise<string | null> {
  try {
    const result = await runProcess({
      program,
      args,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      maxOutputBytes: 16 * 1024,
      timeoutMs: SYSCTL_TIMEOUT_MS
    })
    return result.code === 0 && !result.timedOut && !result.outputTruncated
      ? result.stdout.trim()
      : null
  } catch {
    return null
  }
}

function readSysctl(name: string): Promise<string | null> {
  return readCommand('/usr/sbin/sysctl', ['-n', name])
}

/**
 * What Activity Monitor leaves out of "Memory Used" (app + wired + compressed), from `vm_stat`.
 * The kernel's free percentage also counts memory it could only win back by compressing or
 * swapping, so with heavy swap it reads several GB above what is really free.
 */
export function parseDarwinUnusedBytes(vmStat: string, totalBytes: number): number | null {
  const pageSize = Number.parseInt(/page size of (\d+) bytes/.exec(vmStat)?.[1] ?? '', 10)
  const pages = (label: string): number | null => {
    const value = Number.parseInt(
      new RegExp(`^${label}:\\s+(\\d+)\\.`, 'm').exec(vmStat)?.[1] ?? '',
      10
    )
    return Number.isFinite(value) ? value : null
  }
  const anonymous = pages('Anonymous pages')
  const purgeable = pages('Pages purgeable')
  const wired = pages('Pages wired down')
  const compressed = pages('Pages occupied by compressor')
  if (
    !Number.isFinite(pageSize) ||
    anonymous === null ||
    purgeable === null ||
    wired === null ||
    compressed === null ||
    totalBytes <= 0
  ) {
    return null
  }
  const used = (Math.max(0, anonymous - purgeable) + wired + compressed) * pageSize
  return Math.max(0, totalBytes - used)
}

/** The host's memory for the governor: on macOS, never more free than Activity Monitor would show. */
export async function collectZotzHostMemory(
  collect: () => Promise<HostMemory>,
  platform: NodeJS.Platform = process.platform
): Promise<HostMemory> {
  const host = await collect()
  if (platform !== 'darwin') {
    return host
  }
  const vmStat = await readCommand('/usr/bin/vm_stat', [])
  const unused = vmStat === null ? null : parseDarwinUnusedBytes(vmStat, host.totalMemory)
  if (unused === null || unused >= host.availableMemory) {
    return host
  }
  const used = host.totalMemory - unused
  return {
    ...host,
    availableMemory: unused,
    usedMemory: used,
    memoryUsagePercent: host.totalMemory > 0 ? (used / host.totalMemory) * 100 : 0
  }
}

/** `vm.swapusage` → bytes in use, e.g. "total = 16384.00M  used = 14992.62M  free = …". */
export function parseDarwinSwapUsedBytes(output: string): number | null {
  const match = /used\s*=\s*([\d.]+)([KMG])/.exec(output)
  if (!match) {
    return null
  }
  const unit = match[2] === 'G' ? 1024 ** 3 : match[2] === 'M' ? 1024 ** 2 : 1024
  const value = Number.parseFloat(match[1]) * unit
  return Number.isFinite(value) ? value : null
}

/**
 * macOS-only pressure from the kernel level and recent swap growth. Other platforms answer 'ok'
 * and keep relying on available memory alone.
 */
export function createZotzSystemPressureReader(
  platform: NodeJS.Platform = process.platform,
  now: () => number = Date.now
): () => Promise<ZotzMemoryPressure> {
  const swapSamples: { at: number; used: number }[] = []
  return async () => {
    if (platform !== 'darwin') {
      return 'ok'
    }
    const [levelText, swapText] = await Promise.all([
      readSysctl('kern.memorystatus_vm_pressure_level'),
      readSysctl('vm.swapusage')
    ])
    const level = levelText === null ? null : Number.parseInt(levelText, 10)
    const used = swapText === null ? null : parseDarwinSwapUsedBytes(swapText)
    const at = now()
    while (swapSamples.length > 0 && at - swapSamples[0].at > SWAP_WINDOW_MS) {
      swapSamples.shift()
    }
    if (used !== null) {
      swapSamples.push({ at, used })
    }
    const lowest = swapSamples.reduce((min, sample) => Math.min(min, sample.used), Infinity)
    return zotzSystemMemoryPressure({
      kernelLevel: Number.isFinite(level) ? level : null,
      swapGrowthBytes: used !== null && Number.isFinite(lowest) ? used - lowest : 0
    })
  }
}
