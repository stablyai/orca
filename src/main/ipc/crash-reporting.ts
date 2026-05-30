import os from 'node:os'
import { app, clipboard, ipcMain } from 'electron'
import {
  formatCrashReportText,
  type ReactErrorBoundaryReportArgs,
  type ReactErrorBoundaryReportResult,
  type CrashReportSubmitArgs,
  type CrashReportSubmitResult
} from '../../shared/crash-reporting'
import { submitFeedback } from './feedback'
import type { CrashReportStore } from '../crash-reporting/crash-report-store'
import { getCrashBreadcrumbSnapshot } from '../crash-reporting/crash-breadcrumb-store'

const inFlightSubmissions = new Set<string>()
const submittedReportIds = new Set<string>()
const recentRendererErrorReportKeys = new Map<string, number>()

const RENDERER_ERROR_DEDUPE_MS = 10 * 60 * 1000
const MAX_RENDERER_ERROR_KEY_AGE_MS = RENDERER_ERROR_DEDUPE_MS * 2

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
  'rich-markdown-editor'
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

  ipcMain.removeHandler('crashReports:copyLatestDiagnostics')
  ipcMain.handle(
    'crashReports:copyLatestDiagnostics',
    async (_event, args?: { reportId?: string; notes?: string }) => {
      const report = args?.reportId
        ? await store.getById(args.reportId)
        : await getLatestPendingReport(store)
      if (!report) {
        return { ok: false as const, error: 'No crash report available.' }
      }
      clipboard.writeText(formatCrashReportText(report, args?.notes))
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
      const report = args.reportId
        ? await store.getById(args.reportId)
        : await getLatestPendingReport(store)
      if (!report) {
        return { ok: false, status: null, error: 'No crash report available.' }
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
        const result = await submitFeedback({
          feedback: formatCrashReportText(report, args.notes),
          submissionType: 'crash',
          submitAnonymously: args.submitAnonymously,
          githubLogin: args.githubLogin,
          githubEmail: args.githubEmail
        })
        if (!result.ok) {
          return { ...result, report }
        }
        submittedReportIds.add(report.id)
        if (report.status === 'dismissed') {
          try {
            // Why: startup prompts are dismissed before the user can send from
            // the still-open dialog, so successful uploads must update storage.
            const sent = await store.markDismissedSent(report.id)
            return { ok: true, report: sent ?? { ...report, status: 'sent' } }
          } catch (error) {
            console.error('[crash-reporting] Failed to mark dismissed crash report sent:', error)
            return { ok: true, report: { ...report, status: 'sent' } }
          }
        }
        try {
          const sent = await store.markSent(report.id)
          return { ok: true, report: sent ?? { ...report, status: 'sent' } }
        } catch (error) {
          // Why: the upstream submission already succeeded. A local persistence
          // failure must not present as upload failure or invite duplicate sends
          // during this app session.
          console.error('[crash-reporting] Failed to mark crash report sent:', error)
          return { ok: true, report: { ...report, status: 'sent' } }
        }
      } finally {
        inFlightSubmissions.delete(report.id)
      }
    }
  )
}
