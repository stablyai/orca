import { app } from 'electron'
import type { CrashReportBreadcrumbData } from '../../../shared/crash-reporting/crash-reporting'
import { recordDurableCrashBreadcrumb } from '../../crash-reporting/breadcrumbs/durable-crash-breadcrumb'
import { getWindowsAdministratorRelaunchOptions } from '../../windows/windows-administrator-restart'
import { BACKGROUND_OPEN_ARG } from '../../../shared/app-lifecycle/launch/background-open-argv'
import { prepareProcessRelaunch, type AppImageProcessRelaunch } from './process-relaunch'
import { runWithLaunchPath } from '../shell-environment/hydrate-shell-path'
import { mainProcessState } from '../main-process-state'
import { fenceMainProcessCloudOnQuit } from '../cloud-startup/main-process-connector-startup'
import { destroySystemTray } from '../../tray/system-tray'
import { quitProcess } from './process-quit-request'

export type AppRelaunchReason =
  | 'admin-restart'
  | 'gpu-fallback'
  | 'profile-switch'
  | 'profile-transfer'
  | 'renderer-request'
  | 'windows-administrator'
  | 'wsl-drive-conversion'

export function relaunchApp(
  reason: AppRelaunchReason,
  data?: CrashReportBreadcrumbData,
  options?: Electron.RelaunchOptions
): void {
  recordDurableCrashBreadcrumb('app_relaunch_requested', { ...data, reason })
  runWithLaunchPath(() => app.relaunch(options ?? defaultRelaunchOptions()))
}

export function relaunchAppAndQuit(
  reason: AppRelaunchReason,
  options?: Electron.RelaunchOptions
): void {
  // Electron must retain the request if an updater defers before-quit.
  relaunchApp(reason, undefined, options)
  quitProcess()
}

export function prepareAppRelaunch(
  reason: AppRelaunchReason
): Promise<AppImageProcessRelaunch> | undefined {
  const preparation = prepareProcessRelaunch(defaultRelaunchOptions())
  if (preparation) {
    recordDurableCrashBreadcrumb('app_relaunch_requested', { reason })
  }
  return preparation
}

export async function relaunchRendererAndExit(
  restart: AppImageProcessRelaunch | undefined,
  exitCleanup?: () => void | Promise<void>
): Promise<void> {
  const beforeExit = async (): Promise<void> => {
    mainProcessState.isQuitting = true
    fenceMainProcessCloudOnQuit()
    await runBeforeRelaunchCleanup(exitCleanup)
    // app.exit skips the normal Windows tray cleanup.
    destroySystemTray()
  }
  if (restart) {
    await restart.exit(0, beforeExit)
  } else {
    relaunchApp('renderer-request')
    try {
      await beforeExit()
    } finally {
      app.exit(0)
    }
  }
}

// The user restarted Orca, so the new window comes forward even when `orca open` started this one.
function defaultRelaunchOptions(): Electron.RelaunchOptions | undefined {
  const administrator = getWindowsAdministratorRelaunchOptions()
  if (!administrator && !process.argv.includes(BACKGROUND_OPEN_ARG)) {
    return undefined
  }
  const args = administrator?.args ?? process.argv.slice(1)
  return { ...administrator, args: args.filter((arg) => arg !== BACKGROUND_OPEN_ARG) }
}

export async function runBeforeRelaunchCleanup(
  onBeforeRelaunch?: () => void | Promise<void>
): Promise<void> {
  try {
    await onBeforeRelaunch?.()
  } catch (error) {
    // Cleanup must not block relaunch; log only error.name to keep secrets out of logs.
    console.warn(
      '[app] Pre-relaunch cleanup failed; continuing relaunch:',
      error instanceof Error ? error.name : typeof error
    )
  }
}
