import type { CrashReportStore } from '../../crash-reporting/reports/crash-report-store'

export const inFlightSubmissions = new Set<string>()
export const submittedReportIds = new Set<string>()

const MAX_SUBMITTED_REPORT_IDS = 256
// Help → Report Crash reopens a recently dismissed prompt, never an old one.
const MAX_REOPENED_DISMISSED_REPORT_AGE_MS = 24 * 60 * 60 * 1000

export function rememberSubmittedReportId(reportId: string): void {
  // Bound IPC-controlled report IDs while retaining recent duplicate-send suppression.
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

export async function getLatestPendingReport(
  store: CrashReportStore
): Promise<Awaited<ReturnType<CrashReportStore['getLatestPending']>>> {
  const reports = await store.listRecent()
  return (
    reports.find(
      (report) =>
        report.status === 'pending' &&
        report.reason !== 'main-thread-hang' &&
        !submittedReportIds.has(report.id)
    ) ?? null
  )
}

export async function getLatestSendableReport(
  store: CrashReportStore,
  now = Date.now()
): Promise<Awaited<ReturnType<CrashReportStore['getLatestPending']>>> {
  const reports = await store.listRecent()
  return (
    reports.find(
      (report) =>
        (report.status === 'pending' ||
          (report.status === 'dismissed' &&
            now - Date.parse(report.createdAt) <= MAX_REOPENED_DISMISSED_REPORT_AGE_MS)) &&
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
  // An explicit uncaptured report must not be replaced by a later pending crash.
  return args ? null : getLatestPendingReport(store)
}
