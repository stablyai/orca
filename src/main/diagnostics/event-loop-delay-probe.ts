import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { startSpan } from '../observability/tracer'
import { subscribeSystemPowerLifecycle } from '../power/system-power-lifecycle'

export const EVENT_LOOP_DELAY_PROBE_ENV = 'ORCA_EVENT_LOOP_DELAY_PROBE'
/** Appended in the process's userData directory, one line per window. */
export const EVENT_LOOP_DELAY_REPORT_FILE = 'event-loop-delay.ndjson'

const RESOLUTION_MS = 10
const REPORT_EVERY_MS = 1_000
const TICK_MS = 500
const STALL_SUMMARY_WINDOW_MS = 60_000
/** Input, IPC and browser page loads all wait on a gap this long. */
const STALL_MS = 250
/** Quieter windows write nothing, so the trace grows only while main is struggling. */
const REPORTABLE_MAX_GAP_MS = 100

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

export type EventLoopStallWindow = {
  windowMs: number
  maxGapMs: number
  stalls: number
  stalledMs: number
}

export function isEventLoopDelayProbeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ORCA_E2E_USER_DATA_DIR) || env[EVENT_LOOP_DELAY_PROBE_ENV] === '1'
}

/** Timer drift per tick; a window reports only when its worst gap was felt. */
export function createEventLoopStallSummary(
  startedAt: number,
  report: (window: EventLoopStallWindow) => void
): { tick: (now: number) => void; pause: () => void; resume: (now: number) => void } {
  let lastTick = startedAt
  let windowStart = startedAt
  let paused = false
  let maxGapMs = 0
  let stalls = 0
  let stalledMs = 0
  return {
    tick: (now) => {
      const gap = now - lastTick - TICK_MS
      lastTick = now
      if (!paused && gap > maxGapMs) {
        maxGapMs = gap
      }
      if (!paused && gap >= STALL_MS) {
        stalls += 1
        stalledMs += gap
      }
      if (now - windowStart < STALL_SUMMARY_WINDOW_MS) {
        return
      }
      if (maxGapMs >= REPORTABLE_MAX_GAP_MS) {
        report({
          windowMs: Math.round(now - windowStart),
          maxGapMs: Math.round(maxGapMs),
          stalls,
          stalledMs: Math.round(stalledMs)
        })
      }
      windowStart = now
      maxGapMs = 0
      stalls = 0
      stalledMs = 0
    },
    // System sleep stops timers without blocking the loop; never count it as a stall.
    pause: () => {
      paused = true
    },
    resume: (now) => {
      paused = false
      lastTick = now
    }
  }
}

function traceStallWindow(processKind: EventLoopDelayWindow['process']) {
  return (window: EventLoopStallWindow): void => {
    startSpan('eventLoop.stalls', {
      attributes: {
        'eventLoop.process': processKind,
        'eventLoop.windowMs': window.windowMs,
        'eventLoop.maxGapMs': window.maxGapMs,
        'eventLoop.stalls': window.stalls,
        'eventLoop.stalledMs': window.stalledMs
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
  return (now) => {
    if (now - lastReport < REPORT_EVERY_MS) {
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
      ? createEventLoopStallSummary(startedAt, traceStallWindow(processKind))
      : null
  if (!delayReport && !stallSummary) {
    return
  }
  if (stallSummary) {
    subscribeSystemPowerLifecycle({
      onSuspend: stallSummary.pause,
      onResume: () => stallSummary.resume(performance.now())
    })
  }
  const timer = setInterval(() => {
    const now = performance.now()
    stallSummary?.tick(now)
    delayReport?.(now)
  }, TICK_MS)
  timer.unref?.()
}
