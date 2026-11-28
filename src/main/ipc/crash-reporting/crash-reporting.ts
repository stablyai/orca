import { clipboard, ipcMain } from 'electron'
import type { IpcHandleRegistrar } from '../lazy-ipc-handle-group'
import { getCanonicalUserDataPath } from '../../persistence/loading-store/user-data-path'
import { nativeHangCaptureDirectory } from '../../hang-watchdog/native-hang-capture-store'
import { createPreviousNativeHangReport } from '../../hang-watchdog/previous-native-hang-report'
import { unrecoveredStallImportSettled } from '../../hang-watchdog/previous-unrecovered-stall-import'
import {
  type CrashReportCopyDiagnosticsArgs,
  type CrashReportSubmitArgs,
  formatCrashReportText
} from '../../../shared/crash-reporting/crash-reporting'
import type { CrashReportStore } from '../../crash-reporting/reports/crash-report-store'
import { rendererCrashBreadcrumbOrigin } from '../../../shared/crash-reporting/crash-breadcrumb-origin'
import {
  assertClipboardTextWriteWithinLimit,
  isClipboardTextWriteTooLargeError
} from '../../../shared/clipboard/clipboard-text'
import { formatCrashReportCopyText } from '../../crash-reporting/reports/crash-report-copy-text'
import { recordRendererErrorReport } from './crash-reporting-renderer-error-report'
import { recordRendererBreadcrumbFromRenderer } from './crash-reporting-renderer-breadcrumbs'
import {
  getLatestPendingReport,
  getLatestSendableReport,
  getRequestedCrashReport,
  inFlightSubmissions,
  submittedReportIds
} from './crash-reporting-sendable-reports'
import { buildUncapturedCrashReportText, submitCrashReport } from './crash-reporting-submission'

export function registerCrashReportingHandlers(
  store: CrashReportStore,
  ipc: IpcHandleRegistrar = ipcMain
): void {
  const directory = nativeHangCaptureDirectory(getCanonicalUserDataPath())
  const previousHang =
    process.platform === 'darwin'
      ? createPreviousNativeHangReport({
          store,
          directory,
          processStartedAt: Date.now() - process.uptime() * 1000
        })
      : null
  if (ipc === ipcMain) {
    for (const channel of [
      'crashReports:getLatestPending',
      'crashReports:getLatestReport',
      'crashReports:dismiss',
      'crashReports:copyLatestDiagnostics',
      'crashReports:recordRendererError',
      'crashReports:submit'
    ]) {
      ipcMain.removeHandler(channel)
    }
    ipcMain.removeAllListeners('crashReports:recordBreadcrumb')
    ipcMain.on(
      'crashReports:recordBreadcrumb',
      (event, args?: { name?: unknown; data?: unknown }) => {
        const sender = event?.sender
        const origin =
          typeof sender?.id === 'number' ? rendererCrashBreadcrumbOrigin(sender.id) : undefined
        recordRendererBreadcrumbFromRenderer(args, origin)
      }
    )
  }

  ipc.handle('crashReports:getLatestPending', () => getLatestPendingReport(store))

  ipc.handle('crashReports:getLatestReport', async () => {
    // Every platform with the watchdog files the startup stall import; wait so Help never races it.
    await unrecoveredStallImportSettled()
    await previousHang?.ensureImported()
    return getLatestSendableReport(store)
  })

  ipc.handle('crashReports:dismiss', async (_event, args: { reportId: string }) => {
    if (inFlightSubmissions.has(args.reportId)) {
      return store.getById(args.reportId)
    }
    if (submittedReportIds.has(args.reportId)) {
      const report = await store.getById(args.reportId)
      return report ? { ...report, status: 'sent' as const } : null
    }
    return store.dismiss(args.reportId)
  })

  ipc.handle(
    'crashReports:copyLatestDiagnostics',
    async (_event, args?: CrashReportCopyDiagnosticsArgs) => {
      const report = await getRequestedCrashReport(store, args)
      const baseText = report
        ? formatCrashReportText(report, args?.notes)
        : buildUncapturedCrashReportText(args?.notes)
      try {
        await clipboard.writeText(
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

  ipc.handle('crashReports:recordRendererError', async (event, args: unknown) => {
    try {
      return await recordRendererErrorReport(store, args, event?.sender?.id)
    } catch (error) {
      console.error('[crash-reporting] Failed to record renderer error report:', error)
      return { ok: false, error: 'Failed to record renderer error report.' }
    }
  })

  ipc.handle('crashReports:submit', async (_event, args: CrashReportSubmitArgs) =>
    submitCrashReport(store, args)
  )
}
