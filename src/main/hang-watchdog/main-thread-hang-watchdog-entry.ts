import { isHangWatchdogWorkerData } from './hang-watchdog-worker-protocol'
import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { createHangWatchdogDetectionLoop } from './hang-watchdog-detection-loop'
import { readAvailableHangDetectionMarker, writeHangDetectionMarker } from './hang-detection-marker'
import {
  asHangObservations,
  emptyHangObservations,
  mergeHangObservations,
  parsePowerReceipt,
  retainHangObservation,
  type HangObservation,
  type HangPowerReceipt
} from './hang-observations'
import { captureHangSnapshot } from './hang-snapshot'
import { createWatchdogHangCapture } from './watchdog-hang-capture'
import type {
  HangWatchdogWorkerData,
  MainToHangWatchdogWorkerMessage
} from './hang-watchdog-worker-protocol'

type HangWatchdogPort = {
  on: (event: 'message', listener: (message: MainToHangWatchdogWorkerMessage) => void) => unknown
  close: () => void
  postMessage?: (message: { type: 'capture-drain'; token: string }) => void
}

export function runWatchdog(
  config: HangWatchdogWorkerData,
  port: HangWatchdogPort | null = parentPort
): void {
  if (!port) {
    return
  }
  const initial = readAvailableHangDetectionMarker(config.markerPath)
  let observations = asHangObservations(initial) ?? emptyHangObservations()
  let existingUnavailable = initial === undefined
  let sequence = 0
  let activeStallId: string | null = null
  let stopped = false
  let showMenuBarIcon: boolean | null = null
  let drain: { token: string; acknowledge: () => void } | null = null
  let collector: AbortController | null = null
  let recentPower: HangPowerReceipt[] = []
  let sleepPeriod: { suspend: HangPowerReceipt; resumeAt: number | null } | null = null
  let receiptWindow: { id: string; until: number; remaining: number } | null = null
  const save = (): void => {
    if (!config.markerPath) {
      return
    }
    try {
      if (existingUnavailable) {
        const existing = readAvailableHangDetectionMarker(config.markerPath)
        if (existing === undefined) {
          return
        }
        observations = mergeHangObservations(
          asHangObservations(existing) ?? emptyHangObservations(),
          observations
        )
        existingUnavailable = false
      }
      writeHangDetectionMarker(config.markerPath, observations)
    } catch {
      // Optional diagnostics must not terminate the independent observer.
    }
  }
  const find = (id: string): HangObservation | undefined =>
    observations.observations.find((item) => item.id === id)
  const update = (id: string, change: Partial<HangObservation>): void => {
    const record = find(id)
    if (!record) {
      return
    }
    observations = retainHangObservation(observations, { ...record, ...change })
    save()
  }
  const captures = createWatchdogHangCapture({
    parentPid: config.parentPid,
    artifactDirectory: config.artifactDirectory,
    processMetadata: config.processMetadata,
    publish: update,
    drain: (token) =>
      new Promise<void>((resolve) => {
        drain = { token, acknowledge: resolve }
        port.postMessage?.({ type: 'capture-drain', token })
      }),
    onIdle: () => port.close()
  })
  const openReceiptWindow = (id: string): void => {
    receiptWindow = { id, until: Date.now() + config.checkIntervalMs, remaining: 4 }
  }
  const enrich = (record: HangObservation): void => {
    if (!find(record.id)) {
      return
    }
    if (collector) {
      collector.abort()
      return
    }
    const controller = new AbortController()
    collector = controller
    void import('./hang-incident-snapshot')
      .then(async (incident) => {
        if (controller.signal.aborted || stopped) {
          return
        }
        if (record.kind === 'heartbeat-stall') {
          update(record.id, { completedSpans: incident.readCompletedHangContext(config.tracePath) })
        }
        const machine = await incident.collectHangMachineSnapshot(controller.signal)
        if (!controller.signal.aborted && !stopped) {
          update(record.id, { machine })
        }
      })
      .catch(() => {
        // The durable baseline already records unavailable optional evidence as unknown.
      })
      .finally(() => {
        if (collector === controller) {
          collector = null
        }
      })
  }
  const observe = (kind: HangObservation['kind'], durationMs: number, startedAt: number): void => {
    const detectedAt = performance.now()
    const snapshot = captureHangSnapshot()
    const now = snapshot.wallMs ?? Date.now()
    const suspend = sleepPeriod?.suspend
    const initialSleepAssociated =
      kind === 'watchdog-gap' &&
      !!suspend &&
      suspend.observedAt <= startedAt + config.checkIntervalMs &&
      suspend.receivedAt <= startedAt + config.checkIntervalMs &&
      suspend.receivedAt < now - config.checkIntervalMs &&
      suspend.receivedAt >= suspend.observedAt &&
      suspend.receivedAt - suspend.observedAt <= config.checkIntervalMs &&
      (sleepPeriod?.resumeAt ?? Infinity) > startedAt
    let powerEvents = recentPower
      .filter((item) => item.observedAt >= startedAt && item.receivedAt <= now)
      .slice(-4)
    if (initialSleepAssociated && suspend) {
      powerEvents = [suspend, ...powerEvents.filter((item) => item !== suspend).slice(-3)]
    }
    const record: HangObservation = {
      id: `${config.parentPid}:${now}:${++sequence}`,
      kind,
      detectedAt: now,
      parentPid: config.parentPid,
      durationMs,
      selfRecovered: false,
      snapshot,
      resolution: null,
      machine: null,
      completedSpans: null,
      powerEvents,
      initialSleepAssociated
    }
    observations = retainHangObservation(observations, record)
    if (kind === 'heartbeat-stall') {
      activeStallId = record.id
    }
    openReceiptWindow(record.id)
    save()
    if (!isMainThread) {
      captures.capture(record, detectedAt, showMenuBarIcon)
    }
    enrich(record)
  }
  const loop = createHangWatchdogDetectionLoop({
    timeoutMs: config.timeoutMs,
    checkIntervalMs: config.checkIntervalMs,
    now: () => Date.now(),
    onHangDetected: (durationMs) => observe('heartbeat-stall', durationMs, Date.now() - durationMs),
    onHangResolved: () => {
      if (!activeStallId) {
        return
      }
      const id = activeStallId
      activeStallId = null
      captures.recover(id)
      update(id, { selfRecovered: true, resolution: captureHangSnapshot() })
      openReceiptWindow(id)
    },
    onWatchdogGap: (durationMs, startedAt) => {
      const overlapping = observations.observations.findLast(
        (item) =>
          item.kind === 'heartbeat-stall' &&
          (item.id === activeStallId || (item.resolution?.wallMs ?? -1) >= startedAt)
      )
      if (overlapping) {
        update(overlapping.id, {
          watchdogGap: { observedAt: Date.now(), durationMs, snapshot: captureHangSnapshot() }
        })
        openReceiptWindow(overlapping.id)
      } else {
        observe('watchdog-gap', durationMs, startedAt)
      }
    }
  })
  const checkTimer = setInterval(() => loop.tick(), config.checkIntervalMs)
  port.on('message', (message) => {
    if (message.type === 'capture-drain-ack' && drain?.token === message.token) {
      const pending = drain
      drain = null
      pending.acknowledge()
      return
    }
    if (stopped) {
      return
    }
    if (message.type === 'heartbeat') {
      loop.recordHeartbeat()
    } else if (message.type === 'menu-bar-setting') {
      showMenuBarIcon = message.enabled
    } else if (message.type === 'power-event') {
      const receipt = parsePowerReceipt({ ...message, receivedAt: Date.now() })
      if (!receipt) {
        return
      }
      recentPower = [...recentPower, receipt].slice(-4)
      if (receipt.event === 'suspend') {
        sleepPeriod = { suspend: receipt, resumeAt: null }
      } else if (receipt.event === 'resume' && sleepPeriod) {
        sleepPeriod.resumeAt = receipt.observedAt
      }
      if (
        receiptWindow &&
        receiptWindow.remaining > 0 &&
        receipt.receivedAt <= receiptWindow.until
      ) {
        const record = find(receiptWindow.id)
        if (record) {
          receiptWindow.remaining--
          update(record.id, { powerEvents: [...record.powerEvents, receipt].slice(-4) })
        }
      }
    } else if (message.type === 'shutdown') {
      stopped = true
      receiptWindow = null
      clearInterval(checkTimer)
      collector?.abort()
      captures.shutdown()
    }
  })
}

if (!isMainThread && isHangWatchdogWorkerData(workerData)) {
  runWatchdog(workerData)
}
