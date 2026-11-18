import { appendFile } from 'node:fs/promises'
import { loadavg } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { hasActiveTraceSink, startSpan } from '../observability/tracer'
import { subscribeSystemPowerLifecycle } from '../power/system-power-lifecycle'

export const EVENT_LOOP_DELAY_PROBE_ENV = 'ORCA_EVENT_LOOP_DELAY_PROBE'
/** Appended in the process's userData directory, one line per window. */
export const EVENT_LOOP_DELAY_REPORT_FILE = 'event-loop-delay.ndjson'

const RESOLUTION_MS = 10
const TICK_MS = 500
const REPORT_EVERY_TICKS = 2
/** Main's summary: one window a minute, and quieter windows write nothing. */
const MAIN_STALL_SUMMARY: EventLoopStallSummaryOptions = {
  tickMs: TICK_MS,
  windowMs: 60_000,
  reportableMaxGapMs: 100,
  // Missed sleep events (Windows clocks run on through sleep) must not read as hour-long stalls.
  maxCountedGapMs: 60_000,
  canReport: hasActiveTraceSink
}
/** Input, IPC and browser page loads all wait on a gap this long. */
const STALL_MS = 250

export type EventLoopDelayWindow = {
  process: 'main' | 'orcad'
  pid: number
  /** Epoch ms at the end of the window, so a test can match it to its own phases. */
  t: number
  windowMs: number
  /** Delay beyond the sampling interval, in ms. */
  p50: number
  p99: number
  max: number
  samples: number
}

/** Timer drift only sees blocking that overlaps a tick, so counts are lower bounds; gaps over ~2 ticks always count. */
export type EventLoopStallWindow = {
  windowMs: number
  maxGapMs: number
  /** Main-thread CPU over the tick with the worst gap: near the gap means main was busy, far below it starved or throttled. */
  maxGapCpuMs: number
  stallsSeen: number
  stalledMsSeen: number
  /** Main-thread CPU over the window. */
  cpuMs: number
  /** Longest gap past maxCountedGapMs: a missed sleep event, or a freeze too long to count as a stall. */
  uncountedMaxGapMs: number
}

export type EventLoopStallSummaryOptions = {
  tickMs: number
  windowMs: number
  reportableMaxGapMs: number
  /** Longer gaps are treated as sleep and not counted; unset counts every gap. */
  maxCountedGapMs?: number
  /** False keeps a reportable window open, e.g. while startup has no trace sink yet. */
  canReport?: () => boolean
}

export function isEventLoopDelayProbeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ORCA_E2E_USER_DATA_DIR) || env[EVENT_LOOP_DELAY_PROBE_ENV] === '1'
}

/** Timer drift per tick, given the time and the process's cumulative CPU ms at each tick. */
export function createEventLoopStallSummary(
  startedAt: number,
  options: EventLoopStallSummaryOptions,
  report: (window: EventLoopStallWindow, now: number) => void
): {
  tick: (now: number, cpuMs?: number) => void
  pause: () => void
  resume: (now: number, cpuMs?: number) => void
} {
  let lastTick = startedAt
  let lastCpuMs: number | null = null
  let windowStart = startedAt
  let windowCpuMs = 0
  let paused = false
  let maxGapMs = 0
  let maxGapCpuMs = 0
  let stallsSeen = 0
  let stalledMsSeen = 0
  let uncountedMaxGapMs = 0
  return {
    tick: (now, cpuMs = 0) => {
      const gap = now - lastTick - options.tickMs
      const tickCpuMs = lastCpuMs === null ? 0 : Math.max(0, cpuMs - lastCpuMs)
      lastTick = now
      lastCpuMs = cpuMs
      windowCpuMs += tickCpuMs
      const counted = !paused && gap < (options.maxCountedGapMs ?? Infinity)
      if (!paused && !counted && gap > uncountedMaxGapMs) {
        uncountedMaxGapMs = gap
      }
      if (counted && gap > maxGapMs) {
        maxGapMs = gap
        maxGapCpuMs = tickCpuMs
      }
      if (counted && gap >= STALL_MS) {
        stallsSeen += 1
        stalledMsSeen += gap
      }
      if (now - windowStart < options.windowMs) {
        return
      }
      if (maxGapMs >= options.reportableMaxGapMs || uncountedMaxGapMs > 0) {
        if (options.canReport && !options.canReport()) {
          return
        }
        report(
          {
            windowMs: Math.round(now - windowStart),
            maxGapMs: Math.round(maxGapMs),
            maxGapCpuMs: Math.round(maxGapCpuMs),
            stallsSeen,
            stalledMsSeen: Math.round(stalledMsSeen),
            cpuMs: Math.round(windowCpuMs),
            uncountedMaxGapMs: Math.round(uncountedMaxGapMs)
          },
          now
        )
      }
      windowStart = now
      windowCpuMs = 0
      maxGapMs = 0
      maxGapCpuMs = 0
      stallsSeen = 0
      stalledMsSeen = 0
      uncountedMaxGapMs = 0
    },
    // System sleep stops timers without blocking the loop; never count it as a stall.
    pause: () => {
      paused = true
    },
    resume: (now, cpuMs) => {
      paused = false
      lastTick = now
      lastCpuMs = cpuMs ?? lastCpuMs
    }
  }
}

function mainThreadCpuMs(): number {
  const { user, system } = process.threadCpuUsage()
  return (user + system) / 1_000
}

function traceStallWindow(processKind: EventLoopDelayWindow['process']) {
  return (window: EventLoopStallWindow): void => {
    startSpan('eventLoop.stalls', {
      attributes: {
        'eventLoop.process': processKind,
        'eventLoop.windowMs': window.windowMs,
        'eventLoop.maxGapMs': window.maxGapMs,
        'eventLoop.maxGapCpuMs': window.maxGapCpuMs,
        'eventLoop.stallsSeen': window.stallsSeen,
        'eventLoop.stalledMsSeen': window.stalledMsSeen,
        'eventLoop.cpuMs': window.cpuMs,
        'eventLoop.uncountedMaxGapMs': window.uncountedMaxGapMs,
        // A busy machine starves main without main doing anything; Windows reports no load average.
        ...(process.platform === 'win32' ? {} : { 'host.loadAvg1m': loadavg()[0] })
      }
    }).end()
  }
}

function createDelayReport(
  processKind: EventLoopDelayWindow['process'],
  userDataPath: string,
  startedAt: number
): (now: number) => void {
  const file = join(userDataPath, EVENT_LOOP_DELAY_REPORT_FILE)
  const histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS })
  histogram.enable()
  // The histogram records the whole interval between samples; subtract it to get the delay.
  const delayMs = (ns: number): number =>
    Math.round(Math.max(0, ns / 1e6 - RESOLUTION_MS) * 100) / 100
  let lastReport = startedAt
  let ticks = 0
  return (now) => {
    ticks += 1
    if (ticks % REPORT_EVERY_TICKS !== 0) {
      return
    }
    const windowMs = Math.round(now - lastReport)
    lastReport = now
    const report: EventLoopDelayWindow = {
      process: processKind,
      pid: process.pid,
      t: Date.now(),
      windowMs,
      p50: delayMs(histogram.percentile(50)),
      p99: delayMs(histogram.percentile(99)),
      max: delayMs(histogram.max),
      samples: histogram.count
    }
    histogram.reset()
    appendFile(file, `${JSON.stringify(report)}\n`).catch((error: unknown) => {
      console.warn('[event-loop-delay] could not append the report', error)
    })
  }
}

/**
 * Main always traces a once-a-minute stall summary so a support capture shows main stalls;
 * the per-second histogram file stays opt-in for perf runs.
 */
export function startEventLoopDelayProbe(
  processKind: EventLoopDelayWindow['process'],
  userDataPath: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  const startedAt = performance.now()
  const delayReport = isEventLoopDelayProbeEnabled(env)
    ? createDelayReport(processKind, userDataPath, startedAt)
    : null
  const stallSummary =
    processKind === 'main'
      ? createEventLoopStallSummary(startedAt, MAIN_STALL_SUMMARY, traceStallWindow(processKind))
      : null
  if (!delayReport && !stallSummary) {
    return
  }
  if (stallSummary) {
    subscribeSystemPowerLifecycle({
      onSuspend: stallSummary.pause,
      onResume: () => stallSummary.resume(performance.now(), mainThreadCpuMs())
    })
  }
  const timer = setInterval(() => {
    const now = performance.now()
    stallSummary?.tick(now, mainThreadCpuMs())
    delayReport?.(now)
  }, TICK_MS)
  timer.unref?.()
}
