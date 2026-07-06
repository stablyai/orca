import { app } from 'electron'
import os from 'node:os'

export function collectSystemDiagnosticSummary(): Record<string, unknown> {
  const cpus = os.cpus()
  const totalMemory = os.totalmem()
  const freeMemory = os.freemem()
  return {
    platform: os.platform(),
    arch: os.arch(),
    osRelease: os.release(),
    osVersion: os.version(),
    systemVersion:
      typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : null,
    locale: app.getLocale(),
    cpu: {
      coreCount: Math.max(1, cpus.length),
      model: cpus[0]?.model ?? 'unknown'
    },
    memory: {
      totalMemory,
      freeMemory,
      usedMemory: Math.max(0, totalMemory - freeMemory),
      memoryUsagePercent: totalMemory > 0 ? ((totalMemory - freeMemory) / totalMemory) * 100 : 0
    },
    loadAverage1m: os.loadavg()[0] ?? 0
  }
}
