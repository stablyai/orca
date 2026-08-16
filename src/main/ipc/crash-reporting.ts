import { clipboard, ipcMain } from 'electron'
import {
  type CrashReportCopyDiagnosticsArgs,
  type CrashReportSubmitArgs,
  formatCrashReportText
} from '../../shared/crash-reporting'
import type { CrashReportStore } from '../crash-reporting/crash-report-store'
import {
  assertClipboardTextWriteWithinLimit,
  isClipboardTextWriteTooLargeError
} from '../../shared/clipboard-text'
import { formatCrashReportCopyText } from '../crash-reporting/crash-report-copy-text'
import {
  recentRendererErrorReportKeys,
  recordRendererErrorReport
} from './crash-reporting-renderer-error-report'
import { recordRendererBreadcrumbFromRenderer } from './crash-reporting-renderer-breadcrumbs'
import {
  getLatestPendingReport,
  getLatestSendableReport,
  getRequestedCrashReport,
  inFlightSubmissions,
  submittedReportIds
} from './crash-reporting-sendable-reports'
import { buildUncapturedCrashReportText, submitCrashReport } from './crash-reporting-submission'

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
      recordRendererBreadcrumbFromRenderer(args)
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
  ipcMain.handle('crashReports:submit', async (_event, args: CrashReportSubmitArgs) =>
    submitCrashReport(store, args)
  )
}
