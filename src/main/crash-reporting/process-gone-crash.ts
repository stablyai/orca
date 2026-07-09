import os from 'node:os'
import { app } from 'electron'
import {
  isCrashReportReason,
  type CrashReportBreadcrumb,
  type CrashReportBreadcrumbData,
  type CrashReportCreateInput
} from '../../shared/crash-reporting'
import { startSpan, type ActiveSpan } from '../observability/tracer'
import type { CrashReportStore } from './crash-report-store'
import {
  type ExpectedTeardownScope,
  shouldRecordProcessGoneCrash
} from './process-gone-classification'
import { getProcessGoneDedupeKey, processGoneDedupe } from './process-gone-dedupe'
import {
  buildProcessGoneCrashDetails,
  buildSuppressedProcessGoneBreadcrumbData,
  recordProcessGoneNoCaptureDiagnostic
} from './process-gone-diagnostics'

type CrashReportRecorder = Pick<CrashReportStore, 'record'>

type ProcessGoneDedupeLike = {
  shouldRecord(key: string): boolean
}

export type RecordProcessGoneCrashRuntime = {
  crashReports: CrashReportRecorder | null
  expectedTeardown: ExpectedTeardownScope
  getCrashBreadcrumbSnapshot: () => CrashReportBreadcrumb[]
  recordCrashBreadcrumb: (name: string, data?: CrashReportBreadcrumbData) => void
  dedupe?: ProcessGoneDedupeLike
  getAppVersion?: () => string
  osRelease?: string
  platform?: NodeJS.Platform
  arch?: string
  electronVersion?: string
  chromeVersion?: string
  startSpan?: typeof startSpan
  recordNoCaptureDiagnostic?: typeof recordProcessGoneNoCaptureDiagnostic
}

export function recordProcessGoneCrash(
  source: 'renderer' | 'child',
  processType: string,
  reason: string,
  exitCode: number | null,
  details: Record<string, unknown>,
  runtime: RecordProcessGoneCrashRuntime
): void {
  if (!isCrashReportReason(reason)) {
    return
  }
  const recordNoCaptureDiagnostic =
    runtime.recordNoCaptureDiagnostic ?? recordProcessGoneNoCaptureDiagnostic
  if (!runtime.crashReports) {
    recordNoCaptureDiagnostic('process_gone_store_unavailable', {
      source,
      processType,
      reason,
      exitCode,
      details
    })
    return
  }
  if (
    !shouldRecordProcessGoneCrash({
      source,
      processType,
      serviceName: typeof details.serviceName === 'string' ? details.serviceName : undefined,
      reason,
      exitCode,
      expectedTeardown: runtime.expectedTeardown
    })
  ) {
    runtime.recordCrashBreadcrumb(
      'process_gone_suppressed',
      buildSuppressedProcessGoneBreadcrumbData({
        source,
        processType,
        reason,
        exitCode,
        details
      })
    )
    recordNoCaptureDiagnostic('process_gone_suppressed', {
      source,
      processType,
      reason,
      exitCode,
      details
    })
    return
  }
  const key = getProcessGoneDedupeKey(source, processType, reason, exitCode)
  if (!(runtime.dedupe ?? processGoneDedupe).shouldRecord(key)) {
    return
  }
  const crashDetails = buildProcessGoneCrashDetails(details)
  const breadcrumbs = runtime.getCrashBreadcrumbSnapshot()
  const appVersion = runtime.getAppVersion?.() ?? app.getVersion()
  const crashContext: Omit<CrashReportCreateInput, 'details' | 'breadcrumbs'> = {
    source,
    processType,
    reason,
    exitCode,
    appVersion,
    platform: runtime.platform ?? process.platform,
    osRelease: runtime.osRelease ?? os.release(),
    arch: runtime.arch ?? process.arch,
    electronVersion: runtime.electronVersion ?? process.versions.electron,
    chromeVersion: runtime.chromeVersion ?? process.versions.chrome
  }
  const span: ActiveSpan = (runtime.startSpan ?? startSpan)('electron.process_gone', {
    attributes: {
      'crash.source': source,
      'crash.process_type': processType,
      'crash.reason': reason,
      ...(exitCode !== null ? { 'crash.exit_code': exitCode } : {}),
      'app.version': appVersion,
      platform: crashContext.platform,
      osRelease: crashContext.osRelease,
      arch: crashContext.arch,
      electronVersion: crashContext.electronVersion,
      chromeVersion: crashContext.chromeVersion,
      details: crashDetails,
      breadcrumbs
    }
  })
  // Why: process crashes belong in the local trace lane so diagnostic bundles
  // retain the same process-gone signal as the persisted startup report.
  span.fail(`${source} process gone: ${processType} ${reason} (${exitCode ?? 'unknown'})`)
  void runtime.crashReports
    .record({
      ...crashContext,
      details: crashDetails,
      breadcrumbs
    })
    .catch((error) => {
      console.error('[crash-reporting] Failed to persist crash report:', error)
      recordNoCaptureDiagnostic('process_gone_persist_failed', {
        source,
        processType,
        reason,
        exitCode,
        details,
        error
      })
    })
}
