import { getAppEnvironment } from '../../shared/app-lifecycle/app-environment'
import { clampMemoryMetric } from './memory-snapshot-values'

/** Orca's Electron processes only, read in-process: never spawns, so the closed status bar can poll it. */
export function readAppMemoryTotal(): number {
  let total = 0
  for (const proc of getAppEnvironment().getAppMetrics()) {
    total += clampMemoryMetric(proc.memory?.workingSetSize) * 1024
  }
  return total
}
