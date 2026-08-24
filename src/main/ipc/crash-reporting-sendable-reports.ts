import {
  isUserPromptEligibleCrashReport,
  type CrashReportRecord
} from '../../shared/crash-reporting'
import type { CrashReportStore } from '../crash-reporting/crash-report-store'

export const inFlightSubmissions = new Set<string>()
export const submittedReportIds = new Set<string>()

const MAX_SUBMITTED_REPORT_IDS = 256

export function rememberSubmittedReportId(reportId: string): void {
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

function latestUnsubmittedPendingReport(reports: CrashReportRecord[]): CrashReportRecord | null {
  return (
    reports.find((report) => report.status === 'pending' && !submittedReportIds.has(report.id)) ??
    null
  )
}

/**
 * Feeds the startup "Orca crashed" prompt, so this is the prompt-eligibility
 * gate: embedded browser-content renderer deaths stay recorded (and reachable
 * through listRecent/getById/Help-menu paths) but are skipped here — a web
 * page crashing its own renderer must not read as an app crash. Skipping also
 * keeps a guest death from shadowing an eligible report recorded before it.
 */
export async function getLatestPendingReport(
  store: CrashReportStore
): Promise<Awaited<ReturnType<CrashReportStore['getLatestPending']>>> {
  const reports = await store.listRecent()
  return (
    reports.find(
      (report) =>
        report.status === 'pending' &&
        !submittedReportIds.has(report.id) &&
        isUserPromptEligibleCrashReport(report)
    ) ?? null
  )
}

export async function getLatestSendableReport(
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

export async function getRequestedCrashReport(
  store: CrashReportStore,
  args?: { reportId?: string }
): Promise<Awaited<ReturnType<CrashReportStore['getLatestPending']>>> {
  if (args?.reportId) {
    return store.getById(args.reportId)
  }
  // Why: Help > Report Crash can intentionally submit without a report ID.
  // Do not replace that uncaptured report with a pending crash that appears later.
  if (args) {
    return null
  }
  // Why: this fallback serves user-invoked Help-menu diagnostics, not the crash
  // prompt, so prompt-suppressed guest-renderer reports stay reachable here.
  return latestUnsubmittedPendingReport(await store.listRecent())
}
