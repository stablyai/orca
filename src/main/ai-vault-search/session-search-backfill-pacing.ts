import { cpus, loadavg } from 'node:os'

const BACKFILL_YIELD_MS = 5
// Why: the backfill is the one CPU-heavy thing this feature does, and it runs
// unasked. When the host is already saturated it backs off in coarse steps
// instead of competing; the per-file cursor makes every pause free.
const BACKFILL_LOAD_PER_CPU_CEILING = 1.5
const BACKFILL_LOAD_PAUSE_MS = 15_000

// Why: Windows reports a zero load average, so the only signal left is the
// scanner's own recent CPU share; back off when it has been near a full core.
const WINDOWS_SELF_CPU_SHARE_CEILING = 0.8
let lastCpuSample: { usage: NodeJS.CpuUsage; at: number } | null = null

function selfCpuShareSinceLastYield(): number {
  const now = performance.now()
  const usage = process.cpuUsage()
  const previous = lastCpuSample
  lastCpuSample = { usage, at: now }
  if (!previous) {
    return 0
  }
  const busyMs = (usage.user - previous.usage.user + usage.system - previous.usage.system) / 1000
  const elapsedMs = Math.max(1, now - previous.at)
  return busyMs / elapsedMs
}

/** How long the backfill sleeps after a batch of files: a beat, or a long back-off when the host is busy. */
export function backfillPauseMs(): number {
  if (process.platform === 'win32') {
    return selfCpuShareSinceLastYield() > WINDOWS_SELF_CPU_SHARE_CEILING
      ? BACKFILL_LOAD_PAUSE_MS
      : BACKFILL_YIELD_MS
  }
  const perCpu = loadavg()[0] / Math.max(1, cpus().length)
  return perCpu > BACKFILL_LOAD_PER_CPU_CEILING ? BACKFILL_LOAD_PAUSE_MS : BACKFILL_YIELD_MS
}
