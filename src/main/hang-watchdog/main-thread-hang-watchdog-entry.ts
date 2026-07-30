import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { createHangWatchdogDetectionLoop } from './hang-watchdog-detection-loop'
import { writeHangDetectionMarker } from './hang-detection-marker'
import type {
  HangWatchdogWorkerData,
  MainToHangWatchdogWorkerMessage
} from './hang-watchdog-worker-protocol'

// Observation only: a false positive must never kill a live main thread mid-write.
export function recordHangObservation(options: {
  parentPid: number
  markerPath: string
  unresponsiveMs: number
  selfRecovered: boolean
}): void {
  if (!options.markerPath) {
    return
  }
  try {
    writeHangDetectionMarker(options.markerPath, {
      detectedAt: Date.now(),
      parentPid: options.parentPid,
      unresponsiveMs: options.unresponsiveMs,
      selfRecovered: options.selfRecovered
    })
  } catch {
    // Why: telemetry is best-effort; a marker that cannot be written must not take down the watchdog.
  }
}

function runWatchdog(config: HangWatchdogWorkerData): void {
  const port = parentPort
  if (!port) {
    return
  }
  const loop = createHangWatchdogDetectionLoop({
    timeoutMs: config.timeoutMs,
    checkIntervalMs: config.checkIntervalMs,
    now: () => Date.now(),
    onHangDetected: (unresponsiveMs) =>
      recordHangObservation({
        parentPid: config.parentPid,
        markerPath: config.markerPath,
        unresponsiveMs,
        selfRecovered: false
      }),
    // Why: rewriting the marker keeps one observation per stall rather than two rows to reconcile.
    onHangResolved: (unresponsiveMs) =>
      recordHangObservation({
        parentPid: config.parentPid,
        markerPath: config.markerPath,
        unresponsiveMs,
        selfRecovered: true
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

function isHangWatchdogWorkerData(value: unknown): value is HangWatchdogWorkerData {
  const data = value as Partial<HangWatchdogWorkerData> | null
  return (
    !!data &&
    Number.isInteger(data.parentPid) &&
    (data.parentPid ?? 0) > 0 &&
    typeof data.markerPath === 'string' &&
    Number.isFinite(data.timeoutMs) &&
    (data.timeoutMs ?? 0) > 0 &&
    Number.isFinite(data.checkIntervalMs) &&
    (data.checkIntervalMs ?? 0) > 0
  )
}

if (!isMainThread && isHangWatchdogWorkerData(workerData)) {
  runWatchdog(workerData)
}
