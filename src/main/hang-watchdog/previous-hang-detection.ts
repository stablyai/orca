import { preservePreviousRendererHangs, reportPreviousRendererHangs } from './renderer-hang-records'
import { rmSync } from 'node:fs'
import type { CrashReportBreadcrumbData } from '../../shared/crash-reporting'
import { resolveObservabilityConsent } from '../observability'
import { hasActiveTraceSink } from '../observability/tracer'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/breadcrumbs/durable-crash-breadcrumb'
import { hangCaptureDetails } from './hang-capture-details'
import {
  consumeHangDetectionMarker,
  hangDetectionMarkerPath,
  readAvailableHangDetectionMarker,
  writeHangDetectionMarker,
  type HangDetectionMarker
} from './hang-detection-marker'
import {
  asHangObservations,
  emptyHangObservations,
  latestHangMarker,
  mergeHangObservations,
  type HangObservation
} from './hang-observations'

function previousMarkerPath(userDataPath: string): string {
  return `${hangDetectionMarkerPath(userDataPath)}.previous`
}

export function preservePreviousHangDetection(userDataPath: string): void {
  preservePreviousRendererHangs(userDataPath)
  if (!resolveObservabilityConsent().localFileEnabled) {
    return
  }
  try {
    const currentPath = hangDetectionMarkerPath(userDataPath)
    const pendingPath = previousMarkerPath(userDataPath)
    const current = asHangObservations(readAvailableHangDetectionMarker(currentPath))
    if (!current) {
      return
    }
    const pending = readAvailableHangDetectionMarker(pendingPath)
    if (pending === undefined) {
      return
    }
    const merged = mergeHangObservations(
      asHangObservations(pending) ?? emptyHangObservations(),
      current
    )
    writeHangDetectionMarker(pendingPath, merged)
    rmSync(currentPath, { force: true })
  } catch {
    // Missing or inaccessible markers must not prevent startup; retain any earlier pending note.
  }
}

function observationDetails(record: HangObservation, omitted: number): CrashReportBreadcrumbData {
  const details: CrashReportBreadcrumbData = {
    previousPid: record.parentPid,
    detectedAt: record.detectedAt,
    observationKind: record.kind,
    omittedObservations: omitted,
    activeMainActivity: record.mainJs?.stacks.length
      ? 'sampled-js-window'
      : record.native?.stacks.length
        ? 'sampled-native-window'
        : 'unknown',
    cause: 'unknown',
    cpuScope: 'process-all-threads',
    machineEvidence: record.machine ? 'sampled' : 'unknown'
  }
  if (record.mainJs) {
    Object.assign(details, hangCaptureDetails('mainJs', record.mainJs))
  }
  if (record.native) {
    Object.assign(details, hangCaptureDetails('native', record.native))
  }
  if (record.kind === 'heartbeat-stall') {
    details.unresponsiveMs =
      latestHangMarker({ version: 1, observations: [record], omitted: 0 })?.unresponsiveMs ??
      record.durationMs
    details.detectedUnresponsiveMs = record.durationMs
    details.selfRecovered = record.selfRecovered
  } else {
    details.watchdogGapMs = record.durationMs
    details.preGapCpuDeltaUs = null
  }
  for (const [prefix, snapshot] of [
    ['detection', record.snapshot],
    ['resolution', record.resolution],
    ['gapEnd', record.watchdogGap?.snapshot]
  ] as const) {
    if (snapshot) {
      for (const [key, value] of Object.entries(snapshot)) {
        details[`${prefix}_${key}`] = value
      }
    }
  }
  const before = record.snapshot
  const after = record.resolution
  for (const scope of ['process', 'watchdog'] as const) {
    const firstUser = before?.[`${scope}UserUs`]
    const firstSystem = before?.[`${scope}SystemUs`]
    const lastUser = after?.[`${scope}UserUs`]
    const lastSystem = after?.[`${scope}SystemUs`]
    const delta =
      typeof firstUser === 'number' &&
      typeof firstSystem === 'number' &&
      typeof lastUser === 'number' &&
      typeof lastSystem === 'number'
        ? lastUser + lastSystem - firstUser - firstSystem
        : null
    details[`${scope}CpuDetectionToResolutionUs`] = delta !== null && delta >= 0 ? delta : null
  }
  if (record.machine) {
    for (const [key, value] of Object.entries(record.machine)) {
      details[`machine_${key}`] = value
    }
  }
  if (record.watchdogGap) {
    details.overlappingWatchdogGapMs = record.watchdogGap.durationMs
    details.overlappingWatchdogGapAt = record.watchdogGap.observedAt
  }
  for (const [index, receipt] of record.powerEvents.entries()) {
    details[`power${index}_event`] = receipt.event
    details[`power${index}_mainReceiptAt`] = receipt.observedAt
    details[`power${index}_watchdogReceiptAt`] = receipt.receivedAt
  }
  details.completedContextEvidence =
    record.completedSpans === null ? 'unknown' : 'completed-spans-on-disk'
  for (const [index, span] of (record.completedSpans ?? []).entries()) {
    details[`completed${index}_name`] = span.name
    details[`completed${index}_startedAt`] = span.startedAt
    details[`completed${index}_endedAt`] = span.completedAt
  }
  return details
}

export function reportPreviousHangDetection(userDataPath: string): HangDetectionMarker | null {
  reportPreviousRendererHangs(userDataPath)
  if (!resolveObservabilityConsent().localFileEnabled || !hasActiveTraceSink()) {
    return null
  }
  const marker = consumeHangDetectionMarker(previousMarkerPath(userDataPath))
  const collection = asHangObservations(marker)
  if (!collection) {
    return null
  }
  for (const record of collection.observations) {
    recordDurableCrashBreadcrumb(
      record.kind === 'heartbeat-stall' ? 'main_thread_hang_detected' : 'main_thread_watchdog_gap',
      observationDetails(record, collection.omitted)
    )
  }
  return latestHangMarker(collection)
}
