import os from 'node:os'
import type { RelayDispatcher } from './dispatcher'
// Keep in sync with src/shared/host-resource-metrics-types.ts — HostResourceMetrics.
import type { HostMetricsResult, HostResourceMetrics } from '../shared/host-resource-metrics-types'

export type HostMetricsInput = {
  totalMemory: number
  freeMemory: number
  cpuCoreCount: number
  loadAverage: number[]
  uptimeSeconds: number
  platform: NodeJS.Platform
}

export class HostMetricsHandler {
  constructor(dispatcher: RelayDispatcher) {
    // Why: the relay executes on the target host, so os.* here reflects the remote
    // machine's CPU/memory/load — the metric a client-side prober cannot read.
    dispatcher.onRequest('host.metrics', async () => this.collect())
  }

  private async collect(): Promise<HostMetricsResult> {
    try {
      return {
        metrics: buildHostResourceMetrics({
          totalMemory: os.totalmem(),
          freeMemory: os.freemem(),
          cpuCoreCount: os.cpus().length,
          loadAverage: os.loadavg(),
          uptimeSeconds: os.uptime(),
          platform: process.platform
        })
      }
    } catch {
      // os.* is effectively infallible, but guard so a probe never rejects.
      return { metrics: null }
    }
  }
}

// Why: os.* can return NaN/negative/undefined on exotic platforms; clamp every
// numeric field so the renderer can render without defensive checks.
function clampNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0
  }
  return Math.max(0, value)
}

export function buildHostResourceMetrics(input: HostMetricsInput): HostResourceMetrics {
  const totalMemory = clampNumber(input.totalMemory)
  const freeMemory = Math.min(clampNumber(input.freeMemory), totalMemory)
  const usedMemory = Math.max(0, totalMemory - freeMemory)
  const load = input.loadAverage
  return {
    totalMemory,
    freeMemory,
    usedMemory,
    memoryUsagePercent: totalMemory > 0 ? (usedMemory / totalMemory) * 100 : 0,
    cpuCoreCount: Math.max(1, clampNumber(input.cpuCoreCount)),
    loadAverage1m: clampNumber(load[0]),
    loadAverage5m: clampNumber(load[1]),
    loadAverage15m: clampNumber(load[2]),
    uptimeSeconds: clampNumber(input.uptimeSeconds),
    platform: input.platform
  }
}
