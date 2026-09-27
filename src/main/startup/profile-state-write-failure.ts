import { dialog } from 'electron'
import { isBackgroundLaunch } from '../window/foreground-activation-policy'
import { mainProcessState } from './main-process-state'

/** Report a retired writer without treating unacknowledged state as safe to overwrite. */
export function reportProfileStateWriteFailure(error: Error): void {
  const message = 'Orca has stopped saving this profile.'
  const detail = 'Recent changes may not be saved. Restart Orca before continuing.'
  console.error(`[persistence] ${message} ${detail}`, error)
  if (mainProcessState.isServeMode || isBackgroundLaunch()) {
    return
  }
  void dialog
    .showMessageBox({ type: 'error', title: 'Saving stopped', message, detail, buttons: ['OK'] })
    .catch((dialogError) =>
      console.warn('[persistence] Could not show saving failure:', dialogError)
    )
}
