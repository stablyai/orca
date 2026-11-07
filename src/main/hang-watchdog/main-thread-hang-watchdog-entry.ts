import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { relaunchIfAppKitSceneDeadlocked } from './appkit-scene-deadlock-relaunch'
import { createHangWatchdogDetectionLoop } from './hang-watchdog-detection-loop'
import { writeHangDetectionMarker } from './hang-detection-marker'
import {
  HANG_WATCHDOG_DEADLOCK_CONFIRM_DELAY_MS,
  type HangWatchdogWorkerData,
  type MainToHangWatchdogWorkerMessage
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
  relaunched?: true
}): void {
  if (!options.markerPath) {
    return
  }
  try {
    writeHangDetectionMarker(options.markerPath, {
      detectedAt: Date.now(),
      parentPid: options.parentPid,
      unresponsiveMs: options.unresponsiveMs,
      selfRecovered: options.selfRecovered,
      ...(options.relaunched ? { relaunched: options.relaunched } : {})
    })
  } catch {
    // Diagnostic write failures must not terminate the watchdog.
  }
}

export function runWatchdog(
  config: HangWatchdogWorkerData,
  port: HangWatchdogPort | null = parentPort
): void {
  if (!port) {
    return
  }
  let resolvedStalls = 0
  const loop = createHangWatchdogDetectionLoop({
    timeoutMs: config.timeoutMs,
    checkIntervalMs: config.checkIntervalMs,
    now: () => Date.now(),
    onHangDetected: (unresponsiveMs) => {
      recordHangObservation({
        parentPid: config.parentPid,
        markerPath: config.markerPath,
        unresponsiveMs,
        selfRecovered: false
      })
      if (!config.relaunchBundlePath) {
        return
      }
      const stall = resolvedStalls
      const stallStartedAt = Date.now() - unresponsiveMs
      void relaunchIfAppKitSceneDeadlocked({
        parentPid: config.parentPid,
        bundlePath: config.relaunchBundlePath,
        confirmDelayMs: HANG_WATCHDOG_DEADLOCK_CONFIRM_DELAY_MS,
        isStillHung: () => resolvedStalls === stall,
        onConfirmed: () =>
          recordHangObservation({
            parentPid: config.parentPid,
            markerPath: config.markerPath,
            unresponsiveMs: Date.now() - stallStartedAt,
            selfRecovered: false,
            relaunched: true
          })
      })
    },
    // Update one marker per stall so resolution does not require reconciling a second record.
    onHangResolved: (unresponsiveMs) => {
      resolvedStalls++
      recordHangObservation({
        parentPid: config.parentPid,
        markerPath: config.markerPath,
        unresponsiveMs,
        selfRecovered: true
      })
    }
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
  const data = value as Partial<HangWatchdogWorkerData> | null
  return (
    !!data &&
    Number.isInteger(data.parentPid) &&
    (data.parentPid ?? 0) > 0 &&
    typeof data.markerPath === 'string' &&
    Number.isFinite(data.timeoutMs) &&
    (data.timeoutMs ?? 0) > 0 &&
    Number.isFinite(data.checkIntervalMs) &&
    (data.checkIntervalMs ?? 0) > 0 &&
    (data.relaunchBundlePath === null || typeof data.relaunchBundlePath === 'string')
  )
}

if (!isMainThread && isHangWatchdogWorkerData(workerData)) {
  runWatchdog(workerData)
}
