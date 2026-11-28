import { isHangWatchdogWorkerData } from './hang-watchdog-worker-protocol'
import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { createHangWatchdogDetectionLoop } from './hang-watchdog-detection-loop'
import * as hangMarker from './hang-detection-marker'
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
import { recentWorkerSends } from './hang-recent-worker-sends'
import { sleepAssociation, type SleepPeriod } from './hang-sleep-association'
import {
  escalationFields,
  recoveredTier,
  stallRecoveredMessage,
  suspendedSince,
  tierForSilence,
  type ObserveOptions
} from './hang-stall-tier'
import type {
  HangWatchdogToMainMessage,
  HangWatchdogWorkerData,
  MainToHangWatchdogWorkerMessage
} from './hang-watchdog-worker-protocol'

type HangWatchdogPort = {
  on: (event: 'message', listener: (message: MainToHangWatchdogWorkerMessage) => void) => unknown
  close: () => void
  postMessage?: (message: HangWatchdogToMainMessage) => void
}

export function runWatchdog(
  config: HangWatchdogWorkerData,
  port: HangWatchdogPort | null = parentPort
): void {
  if (!port) {
    return
  }
  const initial = hangMarker.readAvailableHangDetectionMarker(config.markerPath)
  let observations = asHangObservations(initial) ?? emptyHangObservations()
  let existingUnavailable = initial === undefined
  let sequence = 0
  let activeStallId: string | null = null
  let stopped = false
  let showMenuBarIcon: boolean | null = null
  let collector: AbortController | null = null
  let recentPower: HangPowerReceipt[] = []
  let sleepPeriod: SleepPeriod | null = null
  let receiptWindow: { id: string; until: number; remaining: number } | null = null
  const writer = config.markerPath
    ? hangMarker.createHangMarkerWriter(config.markerPath, hangMarker.writeHangDetectionMarker)
    : null
  // Neither the read nor the queued async write throws, so a failure cannot stop the observer.
  const save = (): void => {
    const existing =
      existingUnavailable && config.markerPath
        ? hangMarker.readAvailableHangDetectionMarker(config.markerPath)
        : null
    if (!writer || existing === undefined) {
      return
    }
    if (existingUnavailable) {
      const stored = asHangObservations(existing) ?? emptyHangObservations()
      observations = mergeHangObservations(stored, observations, activeStallId)
      existingUnavailable = false
    }
    writer.write(observations)
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
          const completedSpans = await incident.readCompletedHangContext(config.tracePath)
          if (!controller.signal.aborted && !stopped) {
            update(record.id, { completedSpans })
          }
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
  const observe = (
    kind: HangObservation['kind'],
    durationMs: number,
    startedAt: number,
    options: ObserveOptions = {}
  ): string => {
    const snapshot = captureHangSnapshot()
    const now = snapshot.wallMs ?? Date.now()
    const { initialSleepAssociated, powerEvents } = sleepAssociation({
      kind,
      startedAt,
      now,
      sleepPeriod,
      recentPower,
      checkIntervalMs: config.checkIntervalMs
    })
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
      initialSleepAssociated,
      ...(config.processMetadata?.appVersion
        ? { appVersion: config.processMetadata.appVersion }
        : {}),
      ...(kind === 'heartbeat-stall' ? { workerSends: recentWorkerSends(now) } : {}),
      ...(options.tier ? { tier: options.tier } : {}),
      ...(options.recovered ? { selfRecovered: true } : {})
    }
    const live = kind === 'heartbeat-stall' && !options.recovered
    observations = retainHangObservation(observations, record, { reserve: live })
    if (live) {
      activeStallId = record.id
    }
    openReceiptWindow(record.id)
    // Spawn sample before the marker write: a disk stall that froze main can block the sync write too.
    if (!isMainThread && live && record.tier === 'hang' && find(record.id)) {
      captures.capture(record, showMenuBarIcon)
    }
    save()
    enrich(record)
    return record.id
  }
  const reportRecovered = (id: string, unresponsiveMs: number, endedAt: number): void => {
    port.postMessage?.(stallRecoveredMessage(find(id), unresponsiveMs, endedAt))
  }
  const loop = createHangWatchdogDetectionLoop({
    timeoutMs: config.timeoutMs,
    checkIntervalMs: config.checkIntervalMs,
    now: () => Date.now(),
    stallMs: config.stallMs,
    onStallDetected: (durationMs) => {
      const startedAt = Date.now() - durationMs
      if (suspendedSince(recentPower, startedAt)) {
        return false
      }
      observe('heartbeat-stall', durationMs, startedAt, { tier: 'stall' })
      return true
    },
    onHangDetected: (durationMs) => {
      const stall = activeStallId ? find(activeStallId) : undefined
      if (!stall) {
        observe('heartbeat-stall', durationMs, Date.now() - durationMs, { tier: 'hang' })
        return
      }
      if (!isMainThread) {
        captures.capture(stall, showMenuBarIcon)
      }
      // Same record (and detectedAt) so the native artifact still pairs with it at next launch.
      update(stall.id, escalationFields(stall, durationMs))
    },
    onHangResolved: (unresponsiveMs) => {
      const endedAt = Date.now()
      if (!activeStallId) {
        return
      }
      const id = activeStallId
      activeStallId = null
      const resolution = captureHangSnapshot()
      const tier = recoveredTier(find(id), resolution, unresponsiveMs, config.timeoutMs)
      update(id, { selfRecovered: true, resolution, tier })
      openReceiptWindow(id)
      reportRecovered(id, unresponsiveMs, endedAt)
    },
    onStallEndedBySleep: (durationMs) => {
      const stall = activeStallId ? find(activeStallId) : undefined
      activeStallId = null
      // Marks the stall as ended by the machine, so next launch does not treat it as an unrecovered hang.
      if (stall && !stall.watchdogGap) {
        update(stall.id, {
          watchdogGap: { observedAt: Date.now(), durationMs, snapshot: captureHangSnapshot() }
        })
      }
    },
    onStallMissed: (durationMs, startedAt) => {
      const endedAt = Date.now()
      if (!suspendedSince(recentPower, startedAt)) {
        const tier = tierForSilence(durationMs, config.timeoutMs)
        const id = observe('heartbeat-stall', durationMs, startedAt, { tier, recovered: true })
        reportRecovered(id, durationMs, endedAt)
      }
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
  const checkTimer = setInterval(() => {
    loop.tick()
    // A last tick that stops short of escalation shows the watchdog itself was blocked.
    if (activeStallId && find(activeStallId)?.tier === 'stall') {
      update(activeStallId, { watchdogTickAt: Date.now() })
    }
  }, config.checkIntervalMs)
  port.on('message', (message) => {
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
      // Main sent this, so it answered: a stall still open here ended in a clean quit.
      if (activeStallId) {
        update(activeStallId, { selfRecovered: true, resolution: captureHangSnapshot() })
        activeStallId = null
      }
      // A recovery queued behind an async write would otherwise be lost at exit.
      writer?.flushPending(observations)
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
