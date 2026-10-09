import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { createHangWatchdogDetectionLoop } from './hang-watchdog-detection-loop'
import { writeHangDetectionMarker } from './hang-detection-marker'
import {
  HANG_WATCHDOG_SPAN_BUFFER_BYTES,
  readHangWatchdogSpanSnapshot,
  type HangWatchdogSpanSnapshot
} from './hang-watchdog-active-spans'
import type {
  HangWatchdogWorkerData,
  MainToHangWatchdogWorkerMessage
} from './hang-watchdog-worker-protocol'

type HangWatchdogPort = {
  on: (event: 'message', listener: (message: MainToHangWatchdogWorkerMessage) => void) => unknown
  close: () => void
}

// Observation only: a false positive must never kill a live main thread mid-write.
export function recordHangObservation(options: {
  parentPid: number
  markerPath: string
  unresponsiveMs: number
  selfRecovered: boolean
  spanSnapshot?: HangWatchdogSpanSnapshot
  detectedAt?: number
}): void {
  if (!options.markerPath) {
    return
  }
  try {
    writeHangDetectionMarker(options.markerPath, {
      detectedAt: options.detectedAt ?? Date.now(),
      parentPid: options.parentPid,
      unresponsiveMs: options.unresponsiveMs,
      selfRecovered: options.selfRecovered,
      ...options.spanSnapshot
    })
  } catch {
    // Why: telemetry is best-effort; a marker that cannot be written must not take down the watchdog.
  }
}

export function runWatchdog(
  config: HangWatchdogWorkerData,
  port: HangWatchdogPort | null = parentPort
): void {
  if (!port) {
    return
  }
  let detectedAt: number | undefined
  let spanSnapshot: HangWatchdogSpanSnapshot | undefined
  const loop = createHangWatchdogDetectionLoop({
    timeoutMs: config.timeoutMs,
    checkIntervalMs: config.checkIntervalMs,
    now: () => Date.now(),
    onHangDetected: (unresponsiveMs) => {
      detectedAt = Date.now()
      spanSnapshot = config.activeSpanBuffer
        ? readHangWatchdogSpanSnapshot(config.activeSpanBuffer, detectedAt)
        : undefined
      recordHangObservation({
        parentPid: config.parentPid,
        markerPath: config.markerPath,
        unresponsiveMs,
        selfRecovered: false,
        detectedAt,
        spanSnapshot
      })
    },
    // Why: rewriting the marker keeps one observation per stall rather than two rows to reconcile.
    onHangResolved: (unresponsiveMs) =>
      recordHangObservation({
        parentPid: config.parentPid,
        markerPath: config.markerPath,
        unresponsiveMs,
        selfRecovered: true,
        detectedAt,
        spanSnapshot
      })
  })

  let checkTimer: ReturnType<typeof setInterval> | null = setInterval(
    () => loop.tick(),
    config.checkIntervalMs
  )
  port.on('message', (message: MainToHangWatchdogWorkerMessage) => {
    if (message.type === 'heartbeat') {
      loop.recordHeartbeat()
    } else if (message.type === 'shutdown') {
      if (checkTimer) {
        clearInterval(checkTimer)
        checkTimer = null
      }
      port.close()
    }
  })
}

export function isHangWatchdogWorkerData(value: unknown): value is HangWatchdogWorkerData {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  return (
    'parentPid' in value &&
    typeof value.parentPid === 'number' &&
    Number.isInteger(value.parentPid) &&
    value.parentPid > 0 &&
    'markerPath' in value &&
    typeof value.markerPath === 'string' &&
    'timeoutMs' in value &&
    typeof value.timeoutMs === 'number' &&
    Number.isFinite(value.timeoutMs) &&
    value.timeoutMs > 0 &&
    'checkIntervalMs' in value &&
    typeof value.checkIntervalMs === 'number' &&
    Number.isFinite(value.checkIntervalMs) &&
    value.checkIntervalMs > 0 &&
    (!('activeSpanBuffer' in value) ||
      value.activeSpanBuffer === undefined ||
      (value.activeSpanBuffer instanceof SharedArrayBuffer &&
        value.activeSpanBuffer.byteLength === HANG_WATCHDOG_SPAN_BUFFER_BYTES))
  )
}

if (!isMainThread && isHangWatchdogWorkerData(workerData)) {
  runWatchdog(workerData)
}
