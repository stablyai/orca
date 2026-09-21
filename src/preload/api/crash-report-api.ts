import type {
  CrashReportBreadcrumbData,
  CrashReportCopyDiagnosticsArgs,
  CrashReportRecord,
  CrashReportSubmitArgs,
  CrashReportSubmitResult,
  ReactErrorBoundaryReportArgs,
  ReactErrorBoundaryReportResult
} from '../../shared/crash-reporting'
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
  /** Exact V8/Blink heap sizes; null when the runtime withholds them. */
  readHeapStatistics: () => RendererHeapStatistics | null
  /** This renderer's OS-level footprint, which the heap counters never include. */
  readProcessMemory?: () => Promise<RendererProcessMemory | null>
}

export type FeedbackApi = {
  submit: (args: {
    feedback: string
    submitAnonymously?: boolean
    githubLogin: string | null
    githubEmail: string | null
    images?: { contentType: string; data: Uint8Array }[]
  }) => Promise<
    { ok: true; imagesDelivered?: boolean } | { ok: false; status: number | null; error: string }
  >
}
