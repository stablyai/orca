import type { CrashReportStore } from '../crash-reporting/crash-report-store'

export const inFlightSubmissions = new Set<string>()
export const submittedReportIds = new Set<string>()

const MAX_SUBMITTED_REPORT_IDS = 256

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
    reports.find((report) => report.status === 'pending' && !submittedReportIds.has(report.id)) ??
    null
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
  // An explicit uncaptured report must not be replaced by a later pending crash.
  return args ? null : getLatestPendingReport(store)
}
