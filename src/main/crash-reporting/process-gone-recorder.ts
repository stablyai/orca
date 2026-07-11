import os from 'node:os'
import { app } from 'electron'
import { isCrashReportReason, sanitizeCrashReportString } from '../../shared/crash-reporting'
import type { CrashReportStore } from './crash-report-store'
import { getCrashBreadcrumbSnapshot } from './crash-breadcrumb-store'
import { recordDurableCrashBreadcrumb } from './durable-crash-breadcrumb'
import {
  shouldRecordProcessGoneCrash,
  type ExpectedTeardownScope,
  type ProcessGoneSource
} from './process-gone-classification'
import {
  buildProcessGoneCrashDetails,
  buildSuppressedProcessGoneBreadcrumbData
} from './process-gone-diagnostics'
import {
  getProcessGoneDedupeKey,
  processGoneDedupe,
  type ProcessGoneDedupe
} from './process-gone-dedupe'
import { flushActiveSink, startSpan } from '../observability/tracer'

export type ProcessGoneCrashEvent = {
  source: ProcessGoneSource
  processType: string
  reason: string
  exitCode: number | null
  expectedTeardown: ExpectedTeardownScope
  details: Record<string, unknown>
}

type CrashReportRecorderStore = Pick<CrashReportStore, 'record'>

function processGoneBreadcrumbData(event: ProcessGoneCrashEvent) {
  return buildSuppressedProcessGoneBreadcrumbData(event)
}

function persistFailureData(event: ProcessGoneCrashEvent, error: unknown) {
  const errorCode =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined
  return {
    ...processGoneBreadcrumbData(event),
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: sanitizeCrashReportString(error instanceof Error ? error.message : String(error)),
    ...(errorCode ? { errorCode } : {})
  }
}

export function recordProcessGoneCrash(
  store: CrashReportRecorderStore | null,
  event: ProcessGoneCrashEvent,
  dedupe: ProcessGoneDedupe = processGoneDedupe
): void {
  if (!isCrashReportReason(event.reason)) {
    return
  }
  if (
    !shouldRecordProcessGoneCrash({
      source: event.source,
      processType: event.processType,
      serviceName:
        typeof event.details.serviceName === 'string' ? event.details.serviceName : undefined,
      reason: event.reason,
      exitCode: event.exitCode,
      expectedTeardown: event.expectedTeardown
    })
  ) {
    recordDurableCrashBreadcrumb('process_gone_suppressed', processGoneBreadcrumbData(event))
    return
  }
  if (!store) {
    recordDurableCrashBreadcrumb(
      'crash_report_store_unavailable',
      processGoneBreadcrumbData(event),
      'Crash report store unavailable'
    )
    return
  }

  const key = getProcessGoneDedupeKey(event.source, event.processType, event.reason, event.exitCode)
  const claim = dedupe.tryClaim(key)
  if (!claim) {
    return
  }
  const crashDetails = buildProcessGoneCrashDetails(event.details)
  const breadcrumbs = getCrashBreadcrumbSnapshot()
  const span = startSpan('electron.process_gone', {
    attributes: {
      'crash.source': event.source,
      'crash.process_type': event.processType,
      'crash.reason': event.reason,
      ...(event.exitCode !== null ? { 'crash.exit_code': event.exitCode } : {}),
      'app.version': app.getVersion(),
      platform: process.platform,
      osRelease: os.release(),
      arch: process.arch,
      electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome,
      details: crashDetails,
      breadcrumbs
    }
  })
  // Why: a renderer crash can be followed by another process exit before the
  // trace batch window closes, so make the primary signal durable immediately.
  span.fail(
    `${event.source} process gone: ${event.processType} ${event.reason} (${event.exitCode ?? 'unknown'})`
  )
  flushActiveSink()

  void store
    .record({
      source: event.source,
      processType: event.processType,
      reason: event.reason,
      exitCode: event.exitCode,
      appVersion: app.getVersion(),
      platform: process.platform,
      osRelease: os.release(),
      arch: process.arch,
      electronVersion: process.versions.electron ?? 'unknown',
      chromeVersion: process.versions.chrome ?? 'unknown',
      details: crashDetails,
      breadcrumbs
    })
    .catch((error) => {
      dedupe.release(claim)
      console.error('[crash-reporting] Failed to persist crash report:', error)
      const data = persistFailureData(event, error)
      recordDurableCrashBreadcrumb(
        'crash_report_persist_failed',
        data,
        `${String(data.errorName)}: ${String(data.errorMessage)}`
      )
    })
}
