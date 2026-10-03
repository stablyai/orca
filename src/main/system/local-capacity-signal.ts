import { powerMonitor } from 'electron'
import os from 'node:os'
import { collectHostMemory } from '../memory/host-memory'
import type { HostMemory } from '../../shared/process-stats-types'
import type { LocalCapacitySignal } from '../../shared/local-capacity-signal-types'

export type { LocalCapacitySignal }

const LOW_MEMORY_TOTAL_BYTES = 8 * 1024 ** 3
const LOW_MEMORY_AVAILABLE_RATIO = 0.15
const LOW_CPU_CORE_COUNT = 4

export type LocalCapacitySignalDeps = {
  isOnBatteryPower: () => boolean
  collectHostMemory: () => Promise<HostMemory>
  cpuCount: () => number
}

// Why: the power API is absent on some hosts, and a throw is not evidence of battery (mirrors repo-maintenance-idle-gate).
function isOnBatteryPower(deps: LocalCapacitySignalDeps): boolean {
  try {
    return deps.isOnBatteryPower()
  } catch {
    return false
  }
}

const defaultDeps: LocalCapacitySignalDeps = {
  isOnBatteryPower: () => powerMonitor.isOnBatteryPower(),
  collectHostMemory,
  // Why: os.loadavg is always 0 on Windows, so core count is the portable CPU signal.
  cpuCount: () => os.cpus().length
}

/** Sampled on demand only; callers own any decision to re-read, never an interval here. */
export async function readLocalCapacitySignal(
  deps: LocalCapacitySignalDeps = defaultDeps
): Promise<LocalCapacitySignal> {
  const onBattery = isOnBatteryPower(deps)
  const memory = await deps.collectHostMemory()
  const lowMemory =
    memory.totalMemory < LOW_MEMORY_TOTAL_BYTES ||
    memory.availableMemory < memory.totalMemory * LOW_MEMORY_AVAILABLE_RATIO
  const lowCpu = deps.cpuCount() < LOW_CPU_CORE_COUNT

  const reasons: string[] = []
  if (onBattery) {
    reasons.push('on battery')
  }
  if (lowMemory) {
    reasons.push('low memory')
  }
  if (lowCpu) {
    reasons.push('few CPU cores')
  }

  return { onBattery, lowMemory, lowCpu, reasons }
}
