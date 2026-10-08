import { app } from 'electron'
import type { CrashReportBreadcrumbData } from '../shared/crash-reporting'
import { recordRelaunchExitBreadcrumb } from './crash-reporting/committed-quit-breadcrumb'
import { recordDurableCrashBreadcrumb } from './crash-reporting/durable-crash-breadcrumb'
import { runWithLaunchPath } from './startup/hydrate-shell-path'

export type AppRelaunchReason =
  | 'admin-restart'
  | 'gpu-fallback'
  | 'profile-switch'
  | 'profile-transfer'
  | 'renderer-request'

export function relaunchApp(reason: AppRelaunchReason, data?: CrashReportBreadcrumbData): void {
  // Why: the current process can exit immediately after app.relaunch(), so
  // persist the cause before Electron schedules the replacement process.
  recordDurableCrashBreadcrumb('app_relaunch_requested', { ...data, reason })
  runWithLaunchPath(() => app.relaunch())
}

/** Relaunch paths that leave through `app.exit()` instead of the quit pipeline.
 *  Single choke point so the committed-quit crumb can never be forgotten at one of
 *  them, which is what makes the next launch call a deliberate restart a kill. */
export function relaunchAndExitImmediately(
  reason: AppRelaunchReason,
  data?: CrashReportBreadcrumbData
): void {
  recordRelaunchExitBreadcrumb()
  relaunchApp(reason, data)
  app.exit(0)
}
