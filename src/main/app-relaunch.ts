import { app } from 'electron'
import type { CrashReportBreadcrumbData } from '../shared/crash-reporting'
import { recordDurableCrashBreadcrumb } from './crash-reporting/durable-crash-breadcrumb'
import { runWithLaunchPath } from './startup/hydrate-shell-path'
import { getWindowsAdministratorRelaunchOptions } from './windows/windows-administrator-restart'

export type AppRelaunchReason =
  | 'admin-restart'
  | 'gpu-fallback'
  | 'profile-switch'
  | 'profile-transfer'
  | 'renderer-request'
  | 'windows-administrator'

export function relaunchApp(
  reason: AppRelaunchReason,
  data?: CrashReportBreadcrumbData,
  options?: Electron.RelaunchOptions
): void {
  // Why: the current process can exit immediately after app.relaunch(), so
  // persist the cause before Electron schedules the replacement process.
  recordDurableCrashBreadcrumb('app_relaunch_requested', { ...data, reason })
  runWithLaunchPath(() => app.relaunch(options ?? getWindowsAdministratorRelaunchOptions()))
}

export async function runBeforeRelaunchCleanup(
  onBeforeRelaunch?: () => void | Promise<void>
): Promise<void> {
  try {
    await onBeforeRelaunch?.()
  } catch (error) {
    // Why: best-effort cleanup must never block relaunch; log only error.name to avoid leaking secrets.
    console.warn(
      '[app] Pre-relaunch cleanup failed; continuing relaunch:',
      error instanceof Error ? error.name : typeof error
    )
  }
}
