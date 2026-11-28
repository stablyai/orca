import { ipcMain } from 'electron'
import type { CrashReportStore } from '../../crash-reporting/reports/crash-report-store'
import { rendererCrashBreadcrumbOrigin } from '../../../shared/crash-reporting/crash-breadcrumb-origin'
import { recordRendererBreadcrumbFromRenderer } from './crash-reporting-renderer-breadcrumbs'
import { registerLazyIpcHandleGroup } from '../lazy-ipc-handle-group'

const CRASH_REPORTING_IPC_CHANNELS = [
  'crashReports:getLatestPending',
  'crashReports:getLatestReport',
  'crashReports:dismiss',
  'crashReports:copyLatestDiagnostics',
  'crashReports:recordRendererError',
  'crashReports:submit'
] as const

export function registerLazyCrashReportingHandlers(store: CrashReportStore): void {
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

  for (const channel of CRASH_REPORTING_IPC_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  registerLazyIpcHandleGroup(CRASH_REPORTING_IPC_CHANNELS, async (ipc) => {
    const { registerCrashReportingHandlers } = await import('./crash-reporting')
    registerCrashReportingHandlers(store, ipc)
  })
}
