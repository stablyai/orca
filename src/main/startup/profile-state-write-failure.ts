import { app, dialog, type BrowserWindow, type MessageBoxOptions } from 'electron'
import { translateMain } from '../i18n/main-i18n'
import { profileStateWriterFailureOutcome } from '../persistence/profile-state/profile-state-writer-errors'
import { recordProfileStateWriteFailureReport } from '../persistence/profile-state/profile-state-writer-diagnostics'
import { isBackgroundLaunch } from '../window/foreground-activation-policy'
import { waitForWindowToShow } from '../window/wait-for-window-to-show'
import { mainProcessState } from './main-process-state'

let presenting = false

export function profileStateWriteFailureDialogOptions(error: Error): MessageBoxOptions {
  return {
    type: 'error',
    title: translateMain('profileState.writeFailure.title', 'Saving stopped'),
    message: translateMain(
      'profileState.writeFailure.message',
      'Orca has stopped saving this profile.'
    ),
    detail:
      profileStateWriterFailureOutcome(error) === 'indeterminate'
        ? translateMain(
            'profileState.writeFailure.indeterminateDetail',
            'Orca could not confirm whether your most recent change was saved. New changes will not be saved until you restart Orca.'
          )
        : translateMain(
            'profileState.writeFailure.safeDetail',
            'Changes saved before this point are safe. New changes will not be saved until you restart Orca.'
          ),
    buttons: [translateMain('profileState.writeFailure.okButton', 'OK')]
  }
}

/** Report a retired writer without treating unacknowledged state as safe to overwrite. */
export function reportProfileStateWriteFailure(error: Error): void {
  const options = profileStateWriteFailureDialogOptions(error)
  console.error(`[persistence] ${options.message} ${options.detail}`, error)
  if (mainProcessState.isServeMode || isBackgroundLaunch()) {
    recordProfileStateWriteFailureReport(error, 'suppressed')
    return
  }
  // One sheet at a time: concurrent failures would otherwise stack identical alerts.
  if (presenting) {
    recordProfileStateWriteFailureReport(error, 'duplicate')
    return
  }
  presenting = true
  void presentOnMainWindow(error, options)
    .catch((dialogError: unknown) =>
      console.warn('[persistence] Could not show saving failure:', dialogError)
    )
    .finally(() => {
      presenting = false
    })
}

/**
 * Parentless message boxes run synchronously on macOS and would stall every
 * background save; wait for a visible main window instead of revealing one.
 */
async function presentOnMainWindow(error: Error, options: MessageBoxOptions): Promise<void> {
  let deferred = false
  for (;;) {
    if (mainProcessState.isQuitting) {
      return
    }
    const window = mainProcessState.mainWindow
    if (window && !window.isDestroyed()) {
      if (!window.isVisible() && !deferred) {
        deferred = true
        recordProfileStateWriteFailureReport(error, 'deferred')
      }
      if (await waitForWindowToShow(window)) {
        if (mainProcessState.isQuitting) {
          return
        }
        recordProfileStateWriteFailureReport(error, 'dialog')
        await dialog.showMessageBox(window, options)
        return
      }
    } else if (!deferred) {
      deferred = true
      recordProfileStateWriteFailureReport(error, 'deferred')
    }
    // Only a new window can change the outcome; retrying this one would spin.
    await nextBrowserWindow()
  }
}

function nextBrowserWindow(): Promise<BrowserWindow> {
  return new Promise((resolve) =>
    // Creation fires before the composition root records mainWindow; check on the next turn.
    app.once('browser-window-created', (_event, window) => setImmediate(() => resolve(window)))
  )
}
