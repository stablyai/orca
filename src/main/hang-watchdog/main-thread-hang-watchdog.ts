import { Worker } from 'node:worker_threads'
import { app } from 'electron'
import { hangDetectionMarkerPath } from './hang-detection-marker'
import { resolveHangWatchdogWorkerPath } from './hang-watchdog-worker-path'
import { resolveObservabilityConsent } from '../observability'
import {
  HANG_WATCHDOG_CHECK_INTERVAL_MS,
  HANG_WATCHDOG_HEARTBEAT_INTERVAL_MS,
  HANG_WATCHDOG_TIMEOUT_MS,
  type HangWatchdogWorkerData,
  type MainToHangWatchdogWorkerMessage
} from './hang-watchdog-worker-protocol'

export type MainThreadHangWatchdogHandle = {
  stop: () => void
  worker: Worker
}

function positiveTiming(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function installMainThreadHangWatchdog(options: {
  userDataPath: string
}): MainThreadHangWatchdogHandle | null {
  if (process.platform !== 'darwin') {
    return null
  }
  if (!resolveObservabilityConsent().localFileEnabled) {
    return null
  }
  // Debugger pauses are normal in development; enable only when packaged or explicitly forced.
  if (!app.isPackaged && process.env.ORCA_HANG_WATCHDOG_FORCE !== '1') {
    return null
  }
  const workerPath = resolveHangWatchdogWorkerPath(app.getAppPath(), app.isPackaged)
  const workerData: HangWatchdogWorkerData = {
    parentPid: process.pid,
    markerPath: hangDetectionMarkerPath(options.userDataPath),
    timeoutMs: positiveTiming(process.env.ORCA_HANG_WATCHDOG_TIMEOUT_MS, HANG_WATCHDOG_TIMEOUT_MS),
    checkIntervalMs: positiveTiming(
      process.env.ORCA_HANG_WATCHDOG_CHECK_INTERVAL_MS,
      HANG_WATCHDOG_CHECK_INTERVAL_MS
    )
  }
  let worker: Worker
  try {
    worker = new Worker(workerPath, {
      name: 'orca-main-thread-hang-watchdog',
      workerData
    })
  } catch (error) {
    console.error('[hang-watchdog] failed to start watchdog worker:', error)
    return null
  }
  let stopped = false
  const postMessage = (message: MainToHangWatchdogWorkerMessage): void => {
    if (stopped && message.type === 'heartbeat') {
      return
    }
    try {
      worker.postMessage(message)
    } catch {
      // The worker already exited.
    }
  }
  const heartbeatTimer = setInterval(() => {
    postMessage({ type: 'heartbeat' })
  }, HANG_WATCHDOG_HEARTBEAT_INTERVAL_MS)
  const stop = (): void => {
    if (stopped) {
      return
    }
    stopped = true
    // Drop the app listener immediately so retired workers are not retained by its closure.
    app.off('will-quit', stop)
    clearInterval(heartbeatTimer)
    postMessage({ type: 'shutdown' })
  }
  worker.on('error', (error) => {
    console.error('[hang-watchdog] watchdog worker failed:', error)
    stop()
  })
  worker.once('exit', () => {
    stopped = true
    app.off('will-quit', stop)
    clearInterval(heartbeatTimer)
  })
  worker.unref()
  app.on('will-quit', stop)
  return { stop, worker }
}
