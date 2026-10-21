import { app, dialog } from 'electron'
import { formatProfileStateStartupFailure } from '../persistence/profile-state/profile-state-startup-failure'
import { isBackgroundLaunch } from '../window/foreground-activation-policy'
import { mainProcessState as state } from './main-process-state'
import { SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE } from './single-instance-lock'
import { acquireDesktopProfileInstanceLock } from './desktop-profile-instance-lock'

/** False when orcad holds the profile; unlike a second desktop, nothing else would say why. */
export function acquireDesktopProfileLockOrExplain(userDataPath: string): boolean {
  const profileLock = acquireDesktopProfileInstanceLock(userDataPath)
  if (profileLock.state !== 'held') {
    return true
  }
  handleMainProcessPreflightFailure(
    new Error(profileLock.message),
    SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE
  )
  return false
}

/** Ends a failed preflight without showing a Linux dialog before Electron is ready. */
export function handleMainProcessPreflightFailure(error: unknown, exitCode = 1): void {
  const message =
    formatProfileStateStartupFailure(error) ??
    (error instanceof Error ? error.message : String(error))
  const shouldShowDialog = !state.isServeMode && !isBackgroundLaunch()
  state.desktopActivationGate = null
  const admission = state.profileStateAdmission
  state.profileStateAdmission = undefined
  try {
    admission?.release()
  } catch (releaseError) {
    console.warn('[startup] Could not release profile state admission:', releaseError)
  }

  const showDialogAndExit = (): void => {
    try {
      dialog.showErrorBox('Orca could not start', message)
    } catch (dialogError) {
      console.warn('[startup] Could not show startup failure:', dialogError)
    } finally {
      app.exit(exitCode)
    }
  }
  if (process.platform === 'linux' && shouldShowDialog) {
    try {
      void app.whenReady().then(showDialogAndExit, () => app.exit(exitCode))
    } catch {
      app.exit(exitCode)
    }
  } else if (shouldShowDialog) {
    showDialogAndExit()
  } else {
    app.exit(exitCode)
  }
}
