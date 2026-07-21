/* oxlint-disable max-lines -- Why: crash-reporting IPC handlers share renderer
   error capture, diagnostic upload, and crash-store submission state. */
import os from 'node:os'
import { app, clipboard, ipcMain } from 'electron'
import {
  type CrashReportBreadcrumbData,
  type CrashReportCopyDiagnosticsArgs,
  type CrashReportDiagnosticBundle,
  type ReactErrorBoundaryReportArgs,
  type ReactErrorBoundaryReportResult,
  type CrashReportSubmitArgs,
  type CrashReportSubmitResult,
  formatCrashReportText,
  formatUncapturedCrashReportText,
  sanitizeCrashReportDetails,
  sanitizeCrashReportString
} from '../../shared/crash-reporting'
import { submitFeedback } from './feedback'
import type { CrashReportStore } from '../crash-reporting/crash-report-store'
import {
  getCrashBreadcrumbSnapshot,
  recordCoalescedCrashBreadcrumb,
  recordCrashBreadcrumb
} from '../crash-reporting/crash-breadcrumb-store'
import { startSpan } from '../observability/tracer'
import {
  diagnosticBundleForReportOnlyRetry,
  prepareCrashDiagnosticBundle,
  resolveSubmittedDiagnosticBundle
} from '../crash-reporting/crash-feedback-diagnostic-bundle'
import {
  assertClipboardTextWriteWithinLimit,
  isClipboardTextWriteTooLargeError
} from '../../shared/clipboard-text'
import { formatCrashReportCopyText } from '../crash-reporting/crash-report-copy-text'

const inFlightSubmissions = new Set<string>()
const submittedReportIds = new Set<string>()
const recentRendererErrorReportKeys = new Map<string, number>()

const RENDERER_ERROR_DEDUPE_MS = 10 * 60 * 1000
const MAX_RENDERER_ERROR_KEY_AGE_MS = RENDERER_ERROR_DEDUPE_MS * 2
const MAX_RECENT_RENDERER_ERROR_REPORT_KEYS = 256
const MAX_SUBMITTED_REPORT_IDS = 256

const REACT_ERROR_BOUNDARY_SURFACES = new Set<ReactErrorBoundaryReportArgs['surface']>([
  'app-root',
  'web-root',
  'workspace-shell',
  'sidebar',
  'terminal-workbench',
  'right-sidebar',
  'page',
  'modal',
  'overlay',
  'rich-markdown-editor',
  'dashboard-popout'
])

function stringField(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return undefined
  }
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed
}

function nullableStringField(value: unknown, maxLength: number): string | null | undefined {
  if (value === null) {
    return null
  }
  return stringField(value, maxLength)
}

function normalizeRendererErrorReportArgs(args: unknown): ReactErrorBoundaryReportArgs | null {
  if (!args || typeof args !== 'object') {
    return null
  }
  const record = args as Record<string, unknown>
  const boundaryId = stringField(record.boundaryId, 120)
  const surface = stringField(record.surface, 80)
  const errorName = stringField(record.errorName, 120) ?? 'Error'
  const errorMessage = stringField(record.errorMessage, 1_000) ?? 'Unknown render error'
  if (
    !boundaryId ||
    !surface ||
    !REACT_ERROR_BOUNDARY_SURFACES.has(surface as ReactErrorBoundaryReportArgs['surface'])
  ) {
    return null
  }

  return {
    boundaryId,
    surface: surface as ReactErrorBoundaryReportArgs['surface'],
    errorName,
    errorMessage,
    ...(stringField(record.errorStack, 8_000)
      ? { errorStack: stringField(record.errorStack, 8_000) }
      : {}),
    ...(stringField(record.componentStack, 8_000)
      ? { componentStack: stringField(record.componentStack, 8_000) }
      : {}),
    ...(stringField(record.activeView, 80)
      ? { activeView: stringField(record.activeView, 80) }
      : {}),
    ...(nullableStringField(record.activeModal, 80) !== undefined
      ? { activeModal: nullableStringField(record.activeModal, 80) ?? null }
      : {}),
    ...(stringField(record.activeTabType, 80)
      ? { activeTabType: stringField(record.activeTabType, 80) }
      : {}),
    ...(stringField(record.activeRightSidebarTab, 80)
      ? { activeRightSidebarTab: stringField(record.activeRightSidebarTab, 80) }
      : {}),
    ...(typeof record.hasActiveWorktree === 'boolean'
      ? { hasActiveWorktree: record.hasActiveWorktree }
      : {})
  }
}

function pruneRendererErrorReportKeys(now: number): void {
  for (const [key, seenAt] of recentRendererErrorReportKeys) {
    if (now - seenAt > MAX_RENDERER_ERROR_KEY_AGE_MS) {
      recentRendererErrorReportKeys.delete(key)
    }
  }
  while (recentRendererErrorReportKeys.size > MAX_RECENT_RENDERER_ERROR_REPORT_KEYS) {
    const oldestKey = recentRendererErrorReportKeys.keys().next().value
    if (oldestKey === undefined) {
      break
    }
    recentRendererErrorReportKeys.delete(oldestKey)
  }
}

function getRendererErrorReportKey(args: ReactErrorBoundaryReportArgs): string {
  return JSON.stringify({
    boundaryId: args.boundaryId,
    surface: args.surface,
    errorName: args.errorName,
    errorMessage: args.errorMessage,
    componentStack: args.componentStack
  }).slice(0, 12_000)
}

function rememberSubmittedReportId(reportId: string): void {
  // Why: report ids are IPC input. Keep duplicate-send suppression useful for
  // recent reports without retaining every id a broken renderer can vary.
  submittedReportIds.delete(reportId)
  submittedReportIds.add(reportId)
  while (submittedReportIds.size > MAX_SUBMITTED_REPORT_IDS) {
    const oldestId = submittedReportIds.keys().next().value
    if (oldestId === undefined) {
      break
    }
    submittedReportIds.delete(oldestId)
  }
}

async function recordRendererErrorReport(
  store: CrashReportStore,
  args: unknown
): Promise<ReactErrorBoundaryReportResult> {
  const normalized = normalizeRendererErrorReportArgs(args)
  if (!normalized) {
    return { ok: false, error: 'Invalid renderer error report.' }
  }

  const now = Date.now()
  pruneRendererErrorReportKeys(now)
  const key = getRendererErrorReportKey(normalized)
  if (now - (recentRendererErrorReportKeys.get(key) ?? 0) < RENDERER_ERROR_DEDUPE_MS) {
    return { ok: true, report: null, deduped: true }
  }
  recentRendererErrorReportKeys.set(key, now)
  // Why: renderer error reports are IPC input. A broken renderer can vary the
  // component stack/message inside the age window, so bound the main-side
  // dedupe map by count as well as time.
  pruneRendererErrorReportKeys(now)

  const report = await store.record({
    source: 'renderer',
    processType: 'react-render',
    reason: 'react-error-boundary',
    exitCode: null,
    appVersion: app.getVersion(),
    platform: process.platform,
    osRelease: os.release(),
    arch: process.arch,
    electronVersion: process.versions.electron ?? 'unknown',
    chromeVersion: process.versions.chrome ?? 'unknown',
    details: {
      boundary_id: normalized.boundaryId,
      surface: normalized.surface,
      error_name: normalized.errorName,
      error_message: normalized.errorMessage,
      ...(normalized.errorStack ? { error_stack: normalized.errorStack } : {}),
      ...(normalized.componentStack ? { component_stack: normalized.componentStack } : {}),
      ...(normalized.activeView ? { active_view: normalized.activeView } : {}),
      ...(normalized.activeModal !== undefined ? { active_modal: normalized.activeModal } : {}),
      ...(normalized.activeTabType ? { active_tab_type: normalized.activeTabType } : {}),
      ...(normalized.activeRightSidebarTab
        ? { right_sidebar_tab: normalized.activeRightSidebarTab }
        : {}),
      ...(normalized.hasActiveWorktree !== undefined
        ? { has_active_worktree: normalized.hasActiveWorktree }
        : {})
    },
    // Why: React render failures are recoverable only because a boundary
    // caught them; persist the same recent app breadcrumbs as native crashes.
    breadcrumbs: getCrashBreadcrumbSnapshot()
  })

  return { ok: true, report, deduped: false }
}

export function _resetRendererErrorReportDedupeForTests(): void {
  recentRendererErrorReportKeys.clear()
  submittedReportIds.clear()
  inFlightSubmissions.clear()
}

export function _getCrashReportingStateSizesForTests(): {
  submittedReportIds: number
  inFlightSubmissions: number
  recentRendererErrorReportKeys: number
} {
  return {
    submittedReportIds: submittedReportIds.size,
    inFlightSubmissions: inFlightSubmissions.size,
    recentRendererErrorReportKeys: recentRendererErrorReportKeys.size
  }
}

async function getLatestPendingReport(
  store: CrashReportStore
): Promise<Awaited<ReturnType<CrashReportStore['getLatestPending']>>> {
  const reports = await store.listRecent()
  return (
    reports.find((report) => report.status === 'pending' && !submittedReportIds.has(report.id)) ??
    null
  )
}

async function getLatestSendableReport(
  store: CrashReportStore
): Promise<Awaited<ReturnType<CrashReportStore['getLatestPending']>>> {
  const reports = await store.listRecent()
  return (
    reports.find(
      (report) =>
        (report.status === 'pending' || report.status === 'dismissed') &&
        !submittedReportIds.has(report.id)
    ) ?? null
  )
}

async function getRequestedCrashReport(
  store: CrashReportStore,
  args?: { reportId?: string }
): Promise<Awaited<ReturnType<CrashReportStore['getLatestPending']>>> {
  if (args?.reportId) {
    return store.getById(args.reportId)
  }
  // Why: Help > Report Crash can intentionally submit without a report ID.
  // Do not replace that uncaptured report with a pending crash that appears later.
  return args ? null : getLatestPendingReport(store)
}

function sanitizeRendererBreadcrumbData(value: unknown): CrashReportBreadcrumbData | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const primitiveData: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' || typeof entry === 'boolean' || entry === null) {
      primitiveData[key] = entry
    } else if (typeof entry === 'number' && Number.isFinite(entry)) {
      primitiveData[key] = entry
    }
  }
  const sanitized = sanitizeCrashReportDetails(primitiveData)
  return Object.keys(sanitized).length > 0 ? sanitized : undefined
}

function recordRendererBreadcrumbTrace(
  name: string,
  data: CrashReportBreadcrumbData | undefined
): void {
  const span = startSpan('renderer.breadcrumb', {
    attributes: {
      kind: 'crash-breadcrumb',
      'breadcrumb.name': sanitizeCrashReportString(name),
      ...(data ? { 'breadcrumb.data': data } : {})
    }
  })
  // Why: main-process native crashes cannot persist memory-only breadcrumbs.
  // A tiny trace span gives the next crash report durable pre-crash context.
  span.end()
}

function buildUncapturedCrashReportText(
  notes: string | undefined,
  diagnosticBundle?: CrashReportDiagnosticBundle
): string {
  return formatUncapturedCrashReportText(
    {
      createdAt: new Date().toISOString(),
      appVersion: app.getVersion(),
      platform: os.platform(),
      osRelease: os.release(),
      arch: os.arch(),
      electronVersion: process.versions.electron ?? 'unknown',
      chromeVersion: process.versions.chrome ?? 'unknown'
    },
    notes,
    diagnosticBundle
  )
}

// Why: a repeating renderer error (e.g. a ResizeObserver or SSH-rejection
// storm, #8260) can flush the whole fixed-size breadcrumb ring in seconds,
// erasing the pre-crash trail. Coalesce repeats into one entry that carries a
// suppressed count instead.
const COALESCED_RENDERER_ERROR_BREADCRUMB_NAMES = new Set([
  'renderer_error',
  'renderer_unhandled_rejection'
])
const RENDERER_ERROR_BREADCRUMB_COALESCE_MS = 30_000

function rendererErrorBreadcrumbCoalesceKey(
  name: string,
  data: CrashReportBreadcrumbData | undefined
): string | undefined {
  const primaryMessage = name === 'renderer_error' ? data?.message : data?.reasonMessage
  const fallbackMessage = name === 'renderer_error' ? data?.errorMessage : undefined
  const message =
    typeof primaryMessage === 'string' && primaryMessage.length > 0
      ? primaryMessage
      : typeof fallbackMessage === 'string' && fallbackMessage.length > 0
        ? fallbackMessage
        : undefined
  // Why: message-less failures have no stable identity, so grouping them could
  // erase unrelated crash evidence. Sanitization already caps messages at 240 chars.
  if (!message) {
    return undefined
  }

  // Why: common messages such as "Script error" or "Cannot read properties"
  // can come from unrelated sites. Include sanitized source evidence so one
  // failure cannot suppress the breadcrumb for another.
  const sourceIdentity =
    name === 'renderer_error'
      ? [
          data?.errorStack,
          data?.filename,
          data?.lineno,
          data?.colno,
          data?.errorType,
          data?.errorName,
          data?.errorMessage
        ]
      : [data?.reasonStack, data?.reasonType, data?.reasonName]
  return JSON.stringify([name, message, ...sourceIdentity])
}

export function registerCrashReportingHandlers(store: CrashReportStore): void {
  ipcMain.removeHandler('crashReports:getLatestPending')
  ipcMain.handle('crashReports:getLatestPending', () => getLatestPendingReport(store))

  ipcMain.removeHandler('crashReports:getLatestReport')
  ipcMain.handle('crashReports:getLatestReport', () => getLatestSendableReport(store))

  ipcMain.removeHandler('crashReports:dismiss')
  ipcMain.handle('crashReports:dismiss', async (_event, args: { reportId: string }) => {
    if (inFlightSubmissions.has(args.reportId)) {
      return store.getById(args.reportId)
    }
    if (submittedReportIds.has(args.reportId)) {
      const report = await store.getById(args.reportId)
      return report ? { ...report, status: 'sent' as const } : null
    }
    return store.dismiss(args.reportId)
  })

  ipcMain.removeAllListeners('crashReports:recordBreadcrumb')
  ipcMain.on(
    'crashReports:recordBreadcrumb',
    (_event, args?: { name?: unknown; data?: unknown }) => {
      if (!args || typeof args.name !== 'string') {
        return
      }
      const data = sanitizeRendererBreadcrumbData(args.data)
      if (COALESCED_RENDERER_ERROR_BREADCRUMB_NAMES.has(args.name)) {
        const coalesceKey = rendererErrorBreadcrumbCoalesceKey(args.name, data)
        if (!coalesceKey) {
          recordCrashBreadcrumb(args.name, data)
          recordRendererBreadcrumbTrace(args.name, data)
          return
        }
        const coalesceResult = recordCoalescedCrashBreadcrumb({
          name: args.name,
          data,
          coalesceKey,
          minIntervalMs: RENDERER_ERROR_BREADCRUMB_COALESCE_MS
        })
        // Why: tracing every suppressed duplicate would preserve the same
        // serialization and disk churn that breadcrumb coalescing removes.
        if (coalesceResult) {
          recordRendererBreadcrumbTrace(
            args.name,
            coalesceResult.suppressedSinceLast > 0
              ? { ...data, suppressedSinceLast: coalesceResult.suppressedSinceLast }
              : data
          )
        }
      } else {
        recordCrashBreadcrumb(args.name, data)
        recordRendererBreadcrumbTrace(args.name, data)
      }
    }
  )

  ipcMain.removeHandler('crashReports:copyLatestDiagnostics')
  ipcMain.handle(
    'crashReports:copyLatestDiagnostics',
    async (_event, args?: CrashReportCopyDiagnosticsArgs) => {
      const report = await getRequestedCrashReport(store, args)
      const baseText = report
        ? formatCrashReportText(report, args?.notes)
        : buildUncapturedCrashReportText(args?.notes)
      try {
        clipboard.writeText(
          assertClipboardTextWriteWithinLimit(
            formatCrashReportCopyText(baseText, args?.submissionFailure)
          )
        )
      } catch (error) {
        if (isClipboardTextWriteTooLargeError(error)) {
          return { ok: false as const, error: 'Crash diagnostics are too large to copy safely.' }
        }
        throw error
      }
      return { ok: true as const }
    }
  )

  ipcMain.removeHandler('crashReports:recordRendererError')
  ipcMain.handle('crashReports:recordRendererError', async (_event, args: unknown) => {
    try {
      return await recordRendererErrorReport(store, args)
    } catch (error) {
      console.error('[crash-reporting] Failed to record renderer error report:', error)
      return { ok: false, error: 'Failed to record renderer error report.' }
    }
  })

  ipcMain.removeHandler('crashReports:submit')
  ipcMain.handle(
    'crashReports:submit',
    async (_event, args: CrashReportSubmitArgs): Promise<CrashReportSubmitResult> => {
      const report = await getRequestedCrashReport(store, args)
      if (!report) {
        const diagnosticUpload = prepareCrashDiagnosticBundle(args.includeDiagnosticLogs !== false)
        const diagnosticBundle = diagnosticUpload.diagnosticBundle
        const reportOnlyDiagnosticBundle = diagnosticBundleForReportOnlyRetry(diagnosticUpload)
        const result = await submitFeedback({
          feedback: buildUncapturedCrashReportText(args.notes, diagnosticBundle),
          submissionType: 'crash',
          submitAnonymously: args.submitAnonymously,
          githubLogin: args.githubLogin,
          githubEmail: args.githubEmail,
          ...(diagnosticUpload.feedbackDiagnosticBundle
            ? {
                diagnosticBundle: diagnosticUpload.feedbackDiagnosticBundle,
                feedbackWithoutDiagnosticBundle: buildUncapturedCrashReportText(
                  args.notes,
                  reportOnlyDiagnosticBundle
                )
              }
            : {})
        })
        const submittedDiagnosticBundle = resolveSubmittedDiagnosticBundle(diagnosticUpload, result)
        return result.ok
          ? { ok: true, report: null, diagnosticBundle: submittedDiagnosticBundle }
          : {
              // Why: the transport-only attachment failure may contain raw
              // endpoint detail; only its sanitized bundle reason crosses IPC.
              ok: false,
              status: result.status,
              error: result.error,
              report: null,
              diagnosticBundle: submittedDiagnosticBundle
            }
      }
      const canSubmitDismissedReport = Boolean(args.reportId && report.status === 'dismissed')
      if (
        (!canSubmitDismissedReport && report.status !== 'pending') ||
        submittedReportIds.has(report.id)
      ) {
        return {
          ok: true,
          report: submittedReportIds.has(report.id) ? { ...report, status: 'sent' } : report
        }
      }
      if (inFlightSubmissions.has(report.id)) {
        return {
          ok: false,
          status: null,
          error: 'Crash report submission already in progress.',
          report
        }
      }

      inFlightSubmissions.add(report.id)
      try {
        const diagnosticUpload = prepareCrashDiagnosticBundle(args.includeDiagnosticLogs !== false)
        const diagnosticBundle = diagnosticUpload.diagnosticBundle
        const reportOnlyDiagnosticBundle = diagnosticBundleForReportOnlyRetry(diagnosticUpload)
        const result = await submitFeedback({
          feedback: formatCrashReportText(report, args.notes, diagnosticBundle),
          submissionType: 'crash',
          submitAnonymously: args.submitAnonymously,
          githubLogin: args.githubLogin,
          githubEmail: args.githubEmail,
          ...(diagnosticUpload.feedbackDiagnosticBundle
            ? {
                diagnosticBundle: diagnosticUpload.feedbackDiagnosticBundle,
                feedbackWithoutDiagnosticBundle: formatCrashReportText(
                  report,
                  args.notes,
                  reportOnlyDiagnosticBundle
                )
              }
            : {})
        })
        const submittedDiagnosticBundle = resolveSubmittedDiagnosticBundle(diagnosticUpload, result)
        if (!result.ok) {
          return {
            // Why: keep the renderer contract allow-listed instead of leaking
            // the transport's internal diagnosticBundleFailure object.
            ok: false,
            status: result.status,
            error: result.error,
            report,
            diagnosticBundle: submittedDiagnosticBundle
          }
        }
        rememberSubmittedReportId(report.id)
        if (report.status === 'dismissed') {
          try {
            // Why: startup prompts are dismissed before the user can send from
            // the still-open dialog, so successful uploads must update storage.
            const sent = await store.markDismissedSent(report.id)
            return {
              ok: true,
              report: sent ?? { ...report, status: 'sent' },
              diagnosticBundle: submittedDiagnosticBundle
            }
          } catch (error) {
            console.error('[crash-reporting] Failed to mark dismissed crash report sent:', error)
            return {
              ok: true,
              report: { ...report, status: 'sent' },
              diagnosticBundle: submittedDiagnosticBundle
            }
          }
        }
        try {
          const sent = await store.markSent(report.id)
          return {
            ok: true,
            report: sent ?? { ...report, status: 'sent' },
            diagnosticBundle: submittedDiagnosticBundle
          }
        } catch (error) {
          // Why: the upstream submission already succeeded. A local persistence
          // failure must not present as upload failure or invite duplicate sends
          // during this app session.
          console.error('[crash-reporting] Failed to mark crash report sent:', error)
          return {
            ok: true,
            report: { ...report, status: 'sent' },
            diagnosticBundle: submittedDiagnosticBundle
          }
        }
      } finally {
        inFlightSubmissions.delete(report.id)
      }
    }
  )
}
