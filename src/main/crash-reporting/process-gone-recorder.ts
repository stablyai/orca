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
import { getGpuInfoSnapshot } from './gpu-info-snapshot'
import { getMainProcessLifecycleIdentity } from './main-process-lifecycle-identity'
import { flushActiveSink, startSpan } from '../observability/tracer'

export type ProcessGoneCrashEvent = {
  source: ProcessGoneSource
  processType: string
  reason: string
  exitCode: number | null
  expectedTeardown: ExpectedTeardownScope
  details: Record<string, unknown>
  /** True when this launch already runs a GPU fallback tier, so GPU deaths stop counting as churn. */
  gpuFallbackActive?: boolean
}

type CrashReportRecorderStore = Pick<CrashReportStore, 'record'>

// Why: a GPU crash loop under the fallback would rewrite crash-reports.json every
// dedupe window for the rest of the session; the first few reports carry all the
// triage signal (driver identity, tier), the rest are pure disk churn.
const MAX_GPU_FALLBACK_CRASH_REPORTS_PER_LAUNCH = 3
let gpuFallbackCrashReportsThisLaunch = 0

export function resetGpuFallbackCrashReportBudgetForTesting(): void {
  gpuFallbackCrashReportsThisLaunch = 0
}

function countsAgainstGpuFallbackReportBudget(event: ProcessGoneCrashEvent): boolean {
  return (
    event.gpuFallbackActive === true &&
    event.source === 'child' &&
    event.processType.toLowerCase() === 'gpu'
  )
}

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
      expectedTeardown: event.expectedTeardown,
      gpuFallbackActive: event.gpuFallbackActive
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

  const gpuFallbackBudgeted = countsAgainstGpuFallbackReportBudget(event)
  if (
    gpuFallbackBudgeted &&
    gpuFallbackCrashReportsThisLaunch >= MAX_GPU_FALLBACK_CRASH_REPORTS_PER_LAUNCH
  ) {
    recordDurableCrashBreadcrumb('process_gone_suppressed', {
      ...processGoneBreadcrumbData(event),
      suppressedBy: 'gpu_fallback_report_budget'
    })
    return
  }

  const key = getProcessGoneDedupeKey(event.source, event.processType, event.reason, event.exitCode)
  const claim = dedupe.tryClaim(key)
  if (!claim) {
    return
  }
  if (gpuFallbackBudgeted) {
    gpuFallbackCrashReportsThisLaunch += 1
  }
  const mainProcessLifecycle = getMainProcessLifecycleIdentity()
  // Why: GPU and renderer deaths are the ones triage needs driver identity for;
  // every other child type would just pad the report.
  const gpuIdentity =
    event.source === 'renderer' || event.processType.toLowerCase() === 'gpu'
      ? (getGpuInfoSnapshot() ?? {})
      : {}
  const crashDetails = buildProcessGoneCrashDetails({
    ...event.details,
    ...gpuIdentity,
    ...mainProcessLifecycle
  })
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
      'app.main_process.pid': mainProcessLifecycle.mainProcessPid,
      'app.main_process.launch_id': mainProcessLifecycle.mainProcessLaunchId,
      'app.main_process.started_at': mainProcessLifecycle.mainProcessStartedAt,
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
      if (gpuFallbackBudgeted) {
        gpuFallbackCrashReportsThisLaunch -= 1
      }
      console.error('[crash-reporting] Failed to persist crash report:', error)
      const data = persistFailureData(event, error)
      recordDurableCrashBreadcrumb(
        'crash_report_persist_failed',
        data,
        `${String(data.errorName)}: ${String(data.errorMessage)}`
      )
    })
}
