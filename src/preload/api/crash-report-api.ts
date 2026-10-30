import type {
  CrashReportBreadcrumbData,
  CrashReportCopyDiagnosticsArgs,
  CrashReportRecord,
  CrashReportSubmitArgs,
  CrashReportSubmitResult,
  ReactErrorBoundaryReportArgs,
  ReactErrorBoundaryReportResult
} from '../../shared/crash-reporting'
import type {
  FeedbackSubmitArgs,
  FeedbackSubmitResult
} from '../../shared/feedback-submit-contract'
import type { RendererHeapStatistics } from '../../shared/renderer-heap-statistics'
import type { RendererProcessMemory } from '../../shared/renderer-process-memory'

export type CrashReportsApi = {
  getLatestPending: () => Promise<CrashReportRecord | null>
  getLatestReport: () => Promise<CrashReportRecord | null>
  dismiss: (args: { reportId: string }) => Promise<CrashReportRecord | null>
  recordRendererError: (
    args: ReactErrorBoundaryReportArgs
  ) => Promise<ReactErrorBoundaryReportResult>
  recordBreadcrumb: (args: { name: string; data?: CrashReportBreadcrumbData }) => void
  submit: (args: CrashReportSubmitArgs) => Promise<CrashReportSubmitResult>
  copyLatestDiagnostics: (
    args?: CrashReportCopyDiagnosticsArgs
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  readHeapStatistics: () => RendererHeapStatistics | null
  readProcessMemory?: () => Promise<RendererProcessMemory | null>
}

export type FeedbackApi = {
  submit: (args: FeedbackSubmitArgs) => Promise<FeedbackSubmitResult>
}
