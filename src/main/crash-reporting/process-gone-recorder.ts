import os from 'node:os'
import { app } from 'electron'
import {
  isCrashReportReason,
  sanitizeCrashReportDetails,
  sanitizeCrashReportString,
  type CrashReportBreadcrumbData
} from '../../shared/crash-reporting'
import { decodePosixWaitStatus, describePosixWaitStatus } from '../../shared/posix-wait-status'
import { rendererCrashBreadcrumbOrigin } from '../../shared/crash-breadcrumb-origin'
import type { CrashReportStore } from './crash-report-store'
import { getCrashBreadcrumbSnapshot } from './crash-breadcrumb-store'
import {
  recordCoalescedDurableCrashBreadcrumb,
  recordDurableCrashBreadcrumb
} from './durable-crash-breadcrumb'
import {
  correlateChildProcessDeath,
  trackRendererSiblingAttribution
} from './process-gone-sibling-attribution'
import {
  shouldRecordProcessGoneCrash,
  type ExpectedTeardownScope,
  type ProcessGoneSource
} from './process-gone-classification'
import { buildProcessGoneCrashDetails } from './process-gone-diagnostics'
import { buildSuppressedProcessGoneBreadcrumbData } from './suppressed-process-gone-breadcrumb'
import {
  getProcessGoneDedupeKey,
  processGoneDedupe,
  type ProcessGoneDedupe
} from './process-gone-dedupe'
import {
  findSiblingChildDeaths,
  siblingProcessDeathDetails
} from './process-gone-sibling-correlation'
import { selfInitiatedTreeKillDetails } from './self-initiated-tree-kill-log'
import { getMainProcessLifecycleIdentity } from './main-process-lifecycle-identity'
import {
  captureMinidumpSignature,
  scheduleCrashpadDumpPrune,
  type CapturedMinidump
} from './crashpad-capture'
import { minidumpSignatureDetails } from './minidump-crash-signature'
import { flushActiveSink, startSpan } from '../observability/tracer'

export type ProcessGoneCrashEvent = {
  source: ProcessGoneSource
  processType: string
  reason: string
  exitCode: number | null
  expectedTeardown: ExpectedTeardownScope
  details: Record<string, unknown>
  webContentsId?: number
}

type CrashReportRecorderStore = Pick<CrashReportStore, 'record' | 'attachDetails'>

/** Injectable so tests can drive the pairing without a Crashpad handler. */
export type MinidumpCapture = (
  crashedAtMs: number,
  expectedProcessType: string
) => Promise<CapturedMinidump | null>

const CHILD_CRASHPAD_PROCESS_TYPES: Readonly<Record<string, string>> = {
  gpu: 'gpu-process',
  utility: 'utility',
  zygote: 'zygote'
}

function expectedCrashpadProcessType(event: ProcessGoneCrashEvent): string | null {
  return event.source === 'renderer'
    ? 'renderer'
    : (CHILD_CRASHPAD_PROCESS_TYPES[event.processType.trim().toLowerCase()] ?? null)
}

const captureProcessMinidump: MinidumpCapture = (crashedAtMs, expectedProcessType) =>
  captureMinidumpSignature(crashedAtMs, { expectedProcessType })

// Why: the coalesce map prunes every key against the calling window, so a shorter
// one here would weaken the other 30s coalescers. Stay uniform with them.
const SUPPRESSED_PROCESS_GONE_COALESCE_MS = 30_000

function processGoneRendererOrigin(event: ProcessGoneCrashEvent): string | undefined {
  return event.webContentsId === undefined
    ? undefined
    : rendererCrashBreadcrumbOrigin(event.webContentsId)
}

// Why: key off the emitted breadcrumb, not the crash-report dedupe key, so two
// different recoverable services can never suppress each other's evidence.
function suppressedProcessGoneCoalesceKey(data: CrashReportBreadcrumbData): string {
  return JSON.stringify([
    data.source,
    data.processType,
    data.reason,
    data.exitCode,
    data.expectedTeardown,
    data.serviceName ?? null,
    data.name ?? null,
    data.type ?? null
  ])
}

// Why: POSIX exit codes arrive as raw wait statuses (61696 = exit 241); name the
// meaning on the span so bundles read without manual decoding. Display-only —
// the recorded exitCode stays raw. launch-failed codes are not wait statuses.
function decodedExitCodeAttribute(event: ProcessGoneCrashEvent): Record<string, string> {
  if (process.platform === 'win32' || event.reason === 'launch-failed' || event.exitCode === null) {
    return {}
  }
  const decoded = decodePosixWaitStatus(event.exitCode)
  return decoded ? { 'crash.exit_code_decoded': describePosixWaitStatus(decoded) } : {}
}

function persistFailureData(event: ProcessGoneCrashEvent, error: unknown) {
  const errorCode =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined
  return {
    ...buildSuppressedProcessGoneBreadcrumbData(event),
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: sanitizeCrashReportString(error instanceof Error ? error.message : String(error)),
    ...(errorCode ? { errorCode } : {})
  }
}

/**
 * Folds the Crashpad signature into a report that is already on disk.
 *
 * Why separate from the record write: an exit code of 0x80000003 only says "a
 * CHECK fired"; the name, file and line live in the dump, which Crashpad is
 * still writing when process-gone fires. Waiting inline would stall recovery.
 */
async function attachMinidumpSignature(
  store: CrashReportRecorderStore,
  reportId: string,
  crashedAtMs: number,
  expectedProcessType: string | null,
  capture: MinidumpCapture
): Promise<void> {
  const captured = expectedProcessType ? await capture(crashedAtMs, expectedProcessType) : null
  if (!captured) {
    await store.attachDetails(reportId, { minidumpStatus: 'absent' })
    return
  }
  const signatureDetails = sanitizeCrashReportDetails(minidumpSignatureDetails(captured.signature))
  await store.attachDetails(reportId, {
    ...signatureDetails,
    minidumpStatus: 'captured',
    minidumpPath: captured.filePath,
    minidumpBytes: captured.sizeBytes
  })
  // Why: the crash-report record is capped at 5 entries and is user-facing;
  // the span is what makes the signature countable in the diagnostics bundle.
  const span = startSpan('electron.minidump_signature', {
    attributes: {
      'crash.report_id': reportId,
      'crash.minidump_bytes': captured.sizeBytes,
      ...signatureDetails
    }
  })
  span.end()
  flushActiveSink()
}

export function recordProcessGoneCrash(
  store: CrashReportRecorderStore | null,
  event: ProcessGoneCrashEvent,
  dedupe: ProcessGoneDedupe = processGoneDedupe,
  capture: MinidumpCapture = captureProcessMinidump
): void {
  if (!isCrashReportReason(event.reason)) {
    return
  }
  const goneAt = Date.now()
  const serviceName =
    typeof event.details.serviceName === 'string' ? event.details.serviceName : undefined
  if (event.source === 'child') {
    correlateChildProcessDeath({
      at: goneAt,
      processType: event.processType,
      ...(serviceName ? { serviceName } : {}),
      reason: event.reason,
      exitCode: event.exitCode
    })
  }
  // Crashpad captures suppressed service crashes too; keep a crash loop from
  // filling the disk even when no user-facing report is created.
  scheduleCrashpadDumpPrune()
  if (
    !shouldRecordProcessGoneCrash({
      platform: process.platform,
      source: event.source,
      processType: event.processType,
      serviceName,
      reason: event.reason,
      exitCode: event.exitCode,
      expectedTeardown: event.expectedTeardown
    })
  ) {
    // Why: Chromium can crash-loop a recoverable child (network service seen at
    // 1459/min) and each suppressed event costs a span plus a forced disk flush,
    // which both floods the 30-entry ring and evicts the real pre-crash trail.
    const suppressedData = buildSuppressedProcessGoneBreadcrumbData(event)
    const origin = processGoneRendererOrigin(event)
    recordCoalescedDurableCrashBreadcrumb({
      name: 'process_gone_suppressed',
      data: suppressedData,
      coalesceKey: origin
        ? `${origin}\u0000${suppressedProcessGoneCoalesceKey(suppressedData)}`
        : suppressedProcessGoneCoalesceKey(suppressedData),
      minIntervalMs: SUPPRESSED_PROCESS_GONE_COALESCE_MS,
      ...(origin ? { origin } : {})
    })
    return
  }
  if (!store) {
    recordDurableCrashBreadcrumb(
      'crash_report_store_unavailable',
      buildSuppressedProcessGoneBreadcrumbData(event),
      'Crash report store unavailable',
      processGoneRendererOrigin(event)
    )
    return
  }

  const key = getProcessGoneDedupeKey(
    event.source,
    event.processType,
    event.reason,
    event.exitCode,
    event.webContentsId
  )
  const claim = dedupe.tryClaim(key)
  if (!claim) {
    return
  }
  const mainProcessLifecycle = getMainProcessLifecycleIdentity()
  const siblingDeaths =
    event.source === 'renderer'
      ? findSiblingChildDeaths({ reason: event.reason, exitCode: event.exitCode, at: goneAt })
      : []
  const siblingDetails =
    siblingDeaths.length > 0 ? siblingProcessDeathDetails(siblingDeaths, goneAt) : {}
  const crashDetails = buildProcessGoneCrashDetails(
    {
      ...event.details,
      ...mainProcessLifecycle,
      ...siblingDetails,
      // Why: an Orca-issued kill and an external one are identical in every other
      // recorded field, so this is what answers "did we do this to ourselves?"
      ...selfInitiatedTreeKillDetails(goneAt)
    },
    event.processType
  )
  const breadcrumbs = getCrashBreadcrumbSnapshot(processGoneRendererOrigin(event))
  const reportBreadcrumbs = breadcrumbs?.map(({ origin: _origin, ...breadcrumb }) => breadcrumb)
  const span = startSpan('electron.process_gone', {
    attributes: {
      'crash.source': event.source,
      'crash.process_type': event.processType,
      'crash.reason': event.reason,
      ...(event.exitCode !== null ? { 'crash.exit_code': event.exitCode } : {}),
      ...decodedExitCodeAttribute(event),
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
      breadcrumbs: reportBreadcrumbs
    }
  })
  // Why: a renderer crash can be followed by another process exit before the
  // trace batch window closes, so make the primary signal durable immediately.
  span.fail(
    `${event.source} process gone: ${event.processType} ${event.reason} (${event.exitCode ?? 'unknown'})`
  )
  flushActiveSink()

  const crashedAtMs = Date.now()
  const expectedProcessType = expectedCrashpadProcessType(event)
  const recorded = store.record({
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
    breadcrumbs: reportBreadcrumbs
  })
  trackRendererSiblingAttribution(
    event,
    goneAt,
    siblingDeaths,
    (reportId, details) => store.attachDetails(reportId, details),
    recorded,
    buildSuppressedProcessGoneBreadcrumbData(event),
    processGoneRendererOrigin(event)
  )
  void recorded
    .then((report) => {
      // Why: kept off the returned chain so a minidump failure can never reach
      // the persist-failure handler below and release a claim that did persist.
      void attachMinidumpSignature(
        store,
        report.id,
        crashedAtMs,
        expectedProcessType,
        capture
      ).catch((error) => {
        console.error('[crash-reporting] Failed to attach minidump signature:', error)
        recordDurableCrashBreadcrumb(
          'minidump_signature_attach_failed',
          buildSuppressedProcessGoneBreadcrumbData(event),
          error instanceof Error ? error.message : String(error),
          processGoneRendererOrigin(event)
        )
      })
    })
    .catch((error) => {
      dedupe.release(claim)
      console.error('[crash-reporting] Failed to persist crash report:', error)
      const data = persistFailureData(event, error)
      recordDurableCrashBreadcrumb(
        'crash_report_persist_failed',
        data,
        `${String(data.errorName)}: ${String(data.errorMessage)}`,
        processGoneRendererOrigin(event)
      )
    })
}
