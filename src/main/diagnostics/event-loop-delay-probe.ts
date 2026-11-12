import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'

export const EVENT_LOOP_DELAY_PROBE_ENV = 'ORCA_EVENT_LOOP_DELAY_PROBE'
/** Appended in the process's userData directory, one line per window. */
export const EVENT_LOOP_DELAY_REPORT_FILE = 'event-loop-delay.ndjson'

const RESOLUTION_MS = 10
const REPORT_EVERY_MS = 1_000

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

export function isEventLoopDelayProbeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ORCA_E2E_USER_DATA_DIR) || env[EVENT_LOOP_DELAY_PROBE_ENV] === '1'
}

/** Record event-loop delay throughout the session to capture steady-state stalls. */
export function startEventLoopDelayProbe(
  processKind: EventLoopDelayWindow['process'],
  userDataPath: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (!isEventLoopDelayProbeEnabled(env)) {
    return
  }
  const file = join(userDataPath, EVENT_LOOP_DELAY_REPORT_FILE)
  const histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS })
  histogram.enable()
  // The histogram records the whole interval between samples; subtract it to get the delay.
  const delayMs = (ns: number): number =>
    Math.round(Math.max(0, ns / 1e6 - RESOLUTION_MS) * 100) / 100
  const timer = setInterval(() => {
    const report: EventLoopDelayWindow = {
      process: processKind,
      pid: process.pid,
      t: Date.now(),
      windowMs: REPORT_EVERY_MS,
      p50: delayMs(histogram.percentile(50)),
      p99: delayMs(histogram.percentile(99)),
      max: delayMs(histogram.max),
      samples: histogram.count
    }
    histogram.reset()
    appendFile(file, `${JSON.stringify(report)}\n`).catch((error: unknown) => {
      console.warn('[event-loop-delay] could not append the report', error)
    })
  }, REPORT_EVERY_MS)
  timer.unref?.()
}
