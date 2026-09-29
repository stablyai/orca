import { app, dialog } from 'electron'
import { formatProfileStateStartupFailure } from '../persistence/profile-state/profile-state-startup-failure'
import { isBackgroundLaunch } from '../window/foreground-activation-policy'
import { mainProcessState as state } from './main-process-state'

/** Ends a failed preflight without showing a Linux dialog before Electron is ready. */
export function handleMainProcessPreflightFailure(error: unknown): void {
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
      app.exit(1)
    }
  }
  if (process.platform === 'linux' && shouldShowDialog) {
    try {
      void app.whenReady().then(showDialogAndExit, () => app.exit(1))
    } catch {
      app.exit(1)
    }
  } else if (shouldShowDialog) {
    showDialogAndExit()
  } else {
    app.exit(1)
  }
}
