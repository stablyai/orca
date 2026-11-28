import { app } from 'electron'
import type { CrashReportBreadcrumbData } from '../../../shared/crash-reporting/crash-reporting'
import { recordDurableCrashBreadcrumb } from '../../crash-reporting/breadcrumbs/durable-crash-breadcrumb'
import { runWithLaunchPath } from '../shell-environment/hydrate-shell-path'
import { getWindowsAdministratorRelaunchOptions } from '../../windows/windows-administrator-restart'
import { BACKGROUND_OPEN_ARG } from '../../../shared/app-lifecycle/launch/background-open-argv'
import { writeRuntimeRestartMarker } from '../../runtime/rpc/server/runtime-restart-marker-file'
import { getCanonicalUserDataPath } from '../../persistence/loading-store/user-data-path'

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
  // Persist the cause before relaunch can exit this process.
  recordDurableCrashBreadcrumb('app_relaunch_requested', { ...data, reason })
  runWithLaunchPath(() => app.relaunch(options ?? defaultRelaunchOptions()))
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

/** Same-profile relaunches only: CLI callers in surviving terminals then wait instead of reopening Orca. */
export async function announceRuntimeRelaunch(): Promise<void> {
  await writeRuntimeRestartMarker(getCanonicalUserDataPath(), 'relaunch')
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
