import { clipboard, ipcMain } from 'electron'
import {
  formatCrashReportText,
  type CrashReportSubmitArgs,
  type CrashReportSubmitResult
} from '../../shared/crash-reporting'
import { submitFeedback } from './feedback'
import type { CrashReportStore } from '../crash-reporting/crash-report-store'

const inFlightSubmissions = new Set<string>()
const submittedReportIds = new Set<string>()

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
