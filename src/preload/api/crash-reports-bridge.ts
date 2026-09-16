import { ipcRenderer } from 'electron'
import type {
  CrashReportBreadcrumbData,
  CrashReportCopyDiagnosticsArgs,
  CrashReportSubmitArgs,
  CrashReportSubmitResult,
  ReactErrorBoundaryReportArgs,
  ReactErrorBoundaryReportResult
} from '../../shared/crash-reporting'
import type { RendererHeapStatistics } from '../../shared/renderer-heap-statistics'
import type { RendererProcessMemory } from '../../shared/renderer-process-memory'
import { readRendererHeapStatistics } from '../renderer-heap-statistics-reader'
import { readRendererProcessMemory } from '../renderer-process-memory-reader'
import type { PreloadApi } from '../api-types'

export const crashReportsApi = {
  getLatestPending: () => ipcRenderer.invoke('crashReports:getLatestPending'),
  getLatestReport: () => ipcRenderer.invoke('crashReports:getLatestReport'),
  dismiss: (args: { reportId: string }) => ipcRenderer.invoke('crashReports:dismiss', args),
  recordRendererError: (
    args: ReactErrorBoundaryReportArgs
  ): Promise<ReactErrorBoundaryReportResult> =>
    ipcRenderer.invoke('crashReports:recordRendererError', args),
  recordBreadcrumb: (args: { name: string; data?: CrashReportBreadcrumbData }): void =>
    ipcRenderer.send('crashReports:recordBreadcrumb', args),
  submit: (args: CrashReportSubmitArgs): Promise<CrashReportSubmitResult> =>
    ipcRenderer.invoke('crashReports:submit', args),
  copyLatestDiagnostics: (args?: CrashReportCopyDiagnosticsArgs) =>
    ipcRenderer.invoke('crashReports:copyLatestDiagnostics', args),
  readHeapStatistics: (): RendererHeapStatistics | null => readRendererHeapStatistics(),
  readProcessMemory: (): Promise<RendererProcessMemory | null> => readRendererProcessMemory()
} satisfies PreloadApi['crashReports']
