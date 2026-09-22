import os from 'node:os'
import { app } from 'electron'
import {
  type CrashReportDiagnosticBundle,
  type CrashReportSubmitArgs,
  type CrashReportSubmitResult,
  formatCrashReportText,
  formatUncapturedCrashReportText
} from '../../shared/crash-reporting'
import { submitFeedback } from './feedback'
import type { CrashReportStore } from '../crash-reporting/crash-report-store'
import {
  diagnosticBundleForReportOnlyRetry,
  prepareCrashDiagnosticBundle,
  resolveSubmittedDiagnosticBundle
} from '../crash-reporting/crash-feedback-diagnostic-bundle'
import {
  getRequestedCrashReport,
  inFlightSubmissions,
  rememberSubmittedReportId,
  submittedReportIds
} from './crash-reporting-sendable-reports'

export function buildUncapturedCrashReportText(
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

export async function submitCrashReport(
  store: CrashReportStore,
  args: CrashReportSubmitArgs
): Promise<CrashReportSubmitResult> {
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
