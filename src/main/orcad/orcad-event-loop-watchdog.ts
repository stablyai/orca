// A blocked orcad event loop keeps its process and listener alive while it accepts nothing (#34410).
// The check runs on a worker thread, which a blocked main thread cannot starve.
import inspector from 'node:inspector'
import type { Worker } from 'node:worker_threads'
import { spawnWorkerThread } from '../worker-threads/worker-thread-spawn'

export const ORCAD_EVENT_LOOP_WATCHDOG_ENV = 'ORCA_ORCAD_EVENT_LOOP_WATCHDOG'
const BEAT_INTERVAL_MS = 1_000
const CHECK_INTERVAL_MS = 5_000
/** Logged so a support bundle shows the stall even when nothing else is written. */
const WARN_AFTER_MS = 30_000
/** Well beyond any legitimate synchronous work; only a supervised server, which its service manager restarts, exits. */
const EXIT_AFTER_MS = 5 * 60_000

export type OrcadEventLoopWatchdogData = {
  beat: SharedArrayBuffer
  checkIntervalMs: number
  warnAfterMs: number
  /** Null never exits; the watchdog only reports. */
  exitAfterMs: number | null
}

export type OrcadEventLoopWatchdogMessage =
  | { type: 'started' }
  | { type: 'stalled'; blockedMs: number }
  | { type: 'recovered'; blockedMs: number }

// Plain source, like other eval workers here, so bundling and minification cannot change what the worker runs.
export const ORCAD_EVENT_LOOP_WATCHDOG_WORKER_SOURCE = `
const { workerData: data, parentPort } = require('node:worker_threads')
const fs = require('node:fs')
const beat = new Int32Array(data.beat)
const log = (line) => { try { fs.writeSync(2, line + '\\n') } catch {} }
let lastBeat = Atomics.load(beat, 0)
let lastBeatSeenAt = Date.now()
let lastTickAt = lastBeatSeenAt
let stalled = false
parentPort.postMessage({ type: 'started' })
setInterval(() => {
  const now = Date.now()
  const tickGapMs = now - lastTickAt
  lastTickAt = now
  const current = Atomics.load(beat, 0)
  if (current !== lastBeat) {
    lastBeat = current
    if (stalled) {
      stalled = false
      parentPort.postMessage({ type: 'recovered', blockedMs: now - lastBeatSeenAt })
    }
    lastBeatSeenAt = now
    return
  }
  // System sleep pauses both threads; restart the silence window instead of blaming orcad.
  if (tickGapMs < 0 || tickGapMs > data.checkIntervalMs * 3) {
    lastBeatSeenAt = now
    return
  }
  const blockedMs = now - lastBeatSeenAt
  if (!stalled && blockedMs >= data.warnAfterMs) {
    stalled = true
    log('[orcad] event loop blocked for ' + Math.round(blockedMs / 1000) + 's; requests are not being answered')
    parentPort.postMessage({ type: 'stalled', blockedMs })
  }
  if (data.exitAfterMs !== null && blockedMs >= data.exitAfterMs) {
    log('[orcad] event loop blocked for ' + Math.round(blockedMs / 1000) + 's; exiting so the service manager restarts it')
    // A worker cannot run the main thread's exit handlers; a signal ends the whole process.
    process.kill(process.pid, 'SIGKILL')
  }
}, data.checkIntervalMs)
`

export type OrcadEventLoopWatchdog = { stop: () => void; worker: Worker }

export function startOrcadEventLoopWatchdog(options: {
  supervised: boolean
  env?: NodeJS.ProcessEnv
  timings?: Partial<
    Pick<OrcadEventLoopWatchdogData, 'checkIntervalMs' | 'warnAfterMs' | 'exitAfterMs'>
  > & {
    beatIntervalMs?: number
  }
}): OrcadEventLoopWatchdog | null {
  const env = options.env ?? process.env
  // Debugger pauses block the loop by design.
  if (env[ORCAD_EVENT_LOOP_WATCHDOG_ENV] === '0' || inspector.url()) {
    return null
  }
  const beat = new SharedArrayBuffer(4)
  const beats = new Int32Array(beat)
  const data: OrcadEventLoopWatchdogData = {
    beat,
    checkIntervalMs: options.timings?.checkIntervalMs ?? CHECK_INTERVAL_MS,
    warnAfterMs: options.timings?.warnAfterMs ?? WARN_AFTER_MS,
    exitAfterMs:
      options.timings?.exitAfterMs !== undefined
        ? options.timings.exitAfterMs
        : options.supervised
          ? EXIT_AFTER_MS
          : null
  }
  let worker: Worker
  try {
    worker = spawnWorkerThread(ORCAD_EVENT_LOOP_WATCHDOG_WORKER_SOURCE, {
      eval: true,
      name: 'orcad-event-loop-watchdog',
      workerData: data
    })
  } catch (error) {
    console.warn('[orcad] could not start the event loop watchdog', error)
    return null
  }
  worker.on('message', (message: OrcadEventLoopWatchdogMessage) => {
    if (message.type === 'recovered') {
      console.warn(`[orcad] event loop recovered after ${Math.round(message.blockedMs / 1000)}s`)
    }
  })
  worker.on('error', (error) => console.warn('[orcad] event loop watchdog failed', error))
  worker.unref()
  const timer = setInterval(
    () => Atomics.add(beats, 0, 1),
    options.timings?.beatIntervalMs ?? BEAT_INTERVAL_MS
  )
  timer.unref()
  return {
    worker,
    stop: () => {
      clearInterval(timer)
      void worker.terminate()
    }
  }
}
