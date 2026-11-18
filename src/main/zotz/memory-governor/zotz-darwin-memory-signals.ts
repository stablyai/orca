import { runProcess } from '@orca/process-host'
import {
  zotzSystemMemoryPressure,
  type ZotzMemoryPressure
} from '../../../shared/zotz/agent-queue/zotz-memory-pressure'

const SYSCTL_TIMEOUT_MS = 1_000
// Long enough to span several 15 s samples, short enough that old paging stops counting.
const SWAP_WINDOW_MS = 2 * 60_000

async function readSysctl(name: string): Promise<string | null> {
  try {
    const result = await runProcess({
      program: '/usr/sbin/sysctl',
      args: ['-n', name],
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      maxOutputBytes: 4096,
      timeoutMs: SYSCTL_TIMEOUT_MS
    })
    return result.code === 0 && !result.timedOut ? result.stdout.trim() : null
  } catch {
    return null
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
