import { Worker } from 'node:worker_threads'
import { app } from 'electron'
import { subscribeSystemPowerLifecycle } from '../system-power-lifecycle'
import { hangDetectionMarkerPath, removeClaimedHangDetectionMarker } from './hang-detection-marker'
import { resolveHangWatchdogWorkerPath } from './hang-watchdog-worker-path'
import {
  HANG_WATCHDOG_CHECK_INTERVAL_MS,
  HANG_WATCHDOG_HEARTBEAT_INTERVAL_MS,
  HANG_WATCHDOG_TIMEOUT_MS,
  type HangWatchdogWorkerData,
  type MainToHangWatchdogWorkerMessage
} from './hang-watchdog-worker-protocol'
import type { HangWatchdogWorkerEvent } from './hang-watchdog-worker-protocol'

export type MainThreadHangWatchdogHandle = {
  stop: () => void
  worker: Worker
}

export type WatchdogLaneEvent = {
  unresponsiveMs: number
  episodeId?: number
  outcome?: 'system_slept'
  census?: Record<string, number>
}
const WATCHDOG_QUEUE_CAP = 8
const watchdogQueue: WatchdogLaneEvent[] = []
let watchdogDroppedCount = 0
export function queueWatchdogLaneEvent(event: WatchdogLaneEvent): void {
  if (watchdogQueue.length >= WATCHDOG_QUEUE_CAP) {
    watchdogQueue.shift()
    watchdogDroppedCount += 1
  }
  watchdogQueue.push(event)
}
export function drainWatchdogLaneEvents(): { events: WatchdogLaneEvent[]; dropped_count: number } {
  const events = watchdogQueue.splice(0)
  const dropped_count = watchdogDroppedCount
  watchdogDroppedCount = 0
  return { events, dropped_count }
}

function positiveTiming(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function installMainThreadHangWatchdog(options: {
  userDataPath: string
  onHangResolved?: (event: WatchdogLaneEvent) => void
  heartbeatCensus?: () => Record<string, number>
}): MainThreadHangWatchdogHandle | null {
  // Why: dev main threads pause in debuggers routinely; watch packaged builds only unless forced.
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
    // Why: the worker survives an AppKit main-thread deadlock without another Electron process.
    worker = new Worker(workerPath, {
      name: 'orca-main-thread-hang-watchdog',
      workerData
    })
  } catch (error) {
    console.error('[hang-watchdog] failed to start watchdog worker:', error)
    return null
  }
  worker.on('error', (error) => {
    console.error('[hang-watchdog] watchdog worker failed:', error)
  })
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
    // Keep the heartbeat path bounded: the worker carries forward the last
    // census, while app metrics are captured only at episode edges.
    postMessage({ type: 'heartbeat', census: options.heartbeatCensus?.() ?? {} })
  }, HANG_WATCHDOG_HEARTBEAT_INTERVAL_MS)
  const unsubscribePower = subscribeSystemPowerLifecycle({
    onSuspend: () => {
      if (!stopped) {
        postMessage({ type: 'suspend' })
      }
    },
    onResume: () => {
      if (!stopped) {
        postMessage({ type: 'resume' })
      }
    }
  })
  const stop = (): void => {
    if (stopped) {
      return
    }
    stopped = true
    clearInterval(heartbeatTimer)
    unsubscribePower()
    postMessage({ type: 'shutdown' })
  }
  worker.once('exit', () => {
    stopped = true
    clearInterval(heartbeatTimer)
    unsubscribePower()
  })
  worker.on('message', (message: HangWatchdogWorkerEvent) => {
    if (
      !message?.marker ||
      (message.type !== 'hang_resolved' && message.type !== 'hang_suspended')
    ) {
      return
    }
    const messageType = message.type
    const event: WatchdogLaneEvent = {
      unresponsiveMs: message.marker.unresponsiveMs,
      ...(messageType === 'hang_suspended' ? { outcome: 'system_slept' as const } : {}),
      ...(message.marker.detectedAtMs !== undefined
        ? { episodeId: message.marker.detectedAtMs }
        : {}),
      ...(message.marker.census ? { census: message.marker.census } : {})
    }
    if (options.onHangResolved) {
      try {
        options.onHangResolved(event)
      } finally {
        if (event.episodeId !== undefined) {
          removeClaimedHangDetectionMarker(workerData.markerPath, event.episodeId)
        }
      }
    } else {
      queueWatchdogLaneEvent(event)
    }
  })
  worker.unref()
  app.on('will-quit', stop)
  return { stop, worker }
}
