import { clipboard, ipcMain } from 'electron'
import { formatCrashReportText } from '../../shared/crash-reporting'
import type { CrashReportStore } from '../crash-reporting/crash-report-store'

async function getLatestPendingReport(
  store: CrashReportStore
): Promise<Awaited<ReturnType<CrashReportStore['getLatestPending']>>> {
  const reports = await store.listRecent()
  return reports.find((report) => report.status === 'pending') ?? null
}

export function registerCrashReportingHandlers(store: CrashReportStore): void {
  ipcMain.removeHandler('crashReports:getLatestPending')
  ipcMain.handle('crashReports:getLatestPending', () => getLatestPendingReport(store))

  ipcMain.removeHandler('crashReports:dismiss')
  ipcMain.handle('crashReports:dismiss', async (_event, args: { reportId: string }) => {
    return store.dismiss(args.reportId)
  })

  ipcMain.removeHandler('crashReports:markSent')
  ipcMain.handle('crashReports:markSent', async (_event, args: { reportId: string }) => {
    const report = await store.getById(args.reportId)
    if (!report) {
      return null
    }
    // Why: crash upload now uses the diagnostics bundle lane. This handler
    // only updates the local prompt state after that separate upload succeeds.
    if (report.status === 'dismissed') {
      return store.markDismissedSent(args.reportId)
    }
    if (report.status === 'pending') {
      return store.markSent(args.reportId)
    }
    return report
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
}
