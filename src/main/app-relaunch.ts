import { app } from 'electron'
import type { CrashReportBreadcrumbData } from '../shared/crash-reporting'
import { recordDurableCrashBreadcrumb } from './crash-reporting/durable-crash-breadcrumb'
import {
  labelMainSessionExit,
  recordMainSessionExitSync
} from './crash-reporting/main-session-exit-marker'
import { runWithLaunchPath } from './startup/hydrate-shell-path'

export type AppRelaunchReason =
  | 'admin-restart'
  | 'gpu-fallback'
  | 'profile-switch'
  | 'profile-transfer'
  | 'renderer-request'

/** How the caller ends this process after scheduling the relaunch. */
export type AppRelaunchExitVia = 'app-exit' | 'app-quit'

export function relaunchApp(
  reason: AppRelaunchReason,
  exitVia: AppRelaunchExitVia,
  data?: CrashReportBreadcrumbData
): void {
  // Why: the current process can exit immediately after app.relaunch(), so
  // persist the cause before Electron schedules the replacement process.
  recordDurableCrashBreadcrumb('app_relaunch_requested', { ...data, reason })
  if (exitVia === 'app-exit') {
    // Why sync: app.exit(0) skips will-quit and any pending write.
    recordMainSessionExitSync('relaunch')
  } else {
    // Why deferred: will-quit commits after teardown, so a crash during teardown still reads as unclean.
    labelMainSessionExit('relaunch')
  }
  runWithLaunchPath(() => app.relaunch())
}
