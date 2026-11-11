import { uptime } from 'node:os'
import type { HangSnapshot } from './hang-observations'

export function captureHangSnapshot(): HangSnapshot {
  const cpu = process.cpuUsage()
  let watchdog: NodeJS.CpuUsage | null = null
  try {
    const read = process.threadCpuUsage
    watchdog = read?.call(process) ?? null
  } catch {
    // Some Electron runtimes do not expose per-thread CPU counters.
  }
  return {
    wallMs: Date.now(),
    monotonicMs: performance.now(),
    uptimeSeconds: uptime(),
    processUserUs: cpu.user,
    processSystemUs: cpu.system,
    watchdogUserUs: watchdog?.user ?? null,
    watchdogSystemUs: watchdog?.system ?? null
  }
}
