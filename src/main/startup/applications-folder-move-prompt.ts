import { app, dialog, type BrowserWindow, type MessageBoxOptions } from 'electron'
import { translateMain } from '../i18n/main-i18n'
import { isBackgroundLaunch } from '../window/foreground-activation-policy'
import { mainProcessState as state } from './main-process-state'
import {
  handleApplicationsFolderMoveOffer,
  resolveApplicationsFolderMoveConflict,
  shouldOfferApplicationsFolderMove,
  type ApplicationsFolderMoveDecision
} from './applications-folder-move-decision'

let offeredThisProcess = false

function movePromptOptions(): MessageBoxOptions {
  return {
    type: 'question',
    buttons: [
      translateMain('applicationsFolderMove.prompt.moveButton', 'Move and Relaunch'),
      translateMain('applicationsFolderMove.prompt.notNowButton', 'Not Now'),
      translateMain('applicationsFolderMove.prompt.neverButton', 'Don’t Ask Again')
    ],
    defaultId: 0,
    cancelId: 1,
    title: translateMain('applicationsFolderMove.prompt.title', 'Move Orca to Applications?'),
    message: translateMain(
      'applicationsFolderMove.prompt.message',
      'Move Orca to your Applications folder?'
    ),
    detail: translateMain(
      'applicationsFolderMove.prompt.detail',
      'Orca is running from outside Applications, such as a disk image or Downloads. From there it can’t install updates, and ejecting a disk image while Orca is open can crash it. Orca will quit and reopen from Applications.'
    )
  }
}

function replaceExistingCopyOptions(): MessageBoxOptions {
  return {
    type: 'warning',
    buttons: [
      translateMain('applicationsFolderMove.replace.replaceButton', 'Replace'),
      translateMain('applicationsFolderMove.replace.cancelButton', 'Cancel')
    ],
    defaultId: 0,
    cancelId: 1,
    title: translateMain('applicationsFolderMove.replace.title', 'Replace Orca in Applications?'),
    message: translateMain(
      'applicationsFolderMove.replace.message',
      'Another copy of Orca is already in Applications.'
    ),
    detail: translateMain(
      'applicationsFolderMove.replace.detail',
      'Replacing it moves that copy to the Trash.'
    )
  }
}

function runningCopyOptions(): MessageBoxOptions {
  return {
    type: 'info',
    buttons: [translateMain('applicationsFolderMove.okButton', 'OK')],
    title: translateMain('applicationsFolderMove.running.title', 'Another Orca Is Open'),
    message: translateMain(
      'applicationsFolderMove.running.message',
      'The copy of Orca in Applications is already open.'
    ),
    detail: translateMain(
      'applicationsFolderMove.running.detail',
      'Quit that copy, then reopen this one to move it.'
    )
  }
}

function moveFailedOptions(): MessageBoxOptions {
  return {
    type: 'warning',
    buttons: [translateMain('applicationsFolderMove.okButton', 'OK')],
    title: translateMain('applicationsFolderMove.failed.title', 'Couldn’t Move Orca'),
    message: translateMain(
      'applicationsFolderMove.failed.message',
      'Orca couldn’t be moved to Applications.'
    ),
    detail: translateMain(
      'applicationsFolderMove.failed.detail',
      'Drag Orca into the Applications folder in Finder instead. This copy keeps running.'
    )
  }
}

function showMessageBoxSync(window: BrowserWindow, options: MessageBoxOptions): number {
  return window.isDestroyed()
    ? dialog.showMessageBoxSync(options)
    : dialog.showMessageBoxSync(window, options)
}

async function promptForApplicationsFolderMove(
  window: BrowserWindow
): Promise<ApplicationsFolderMoveDecision> {
  const options = movePromptOptions()
  const { response } = window.isDestroyed()
    ? await dialog.showMessageBox(options)
    : await dialog.showMessageBox(window, options)
  return response === 0 ? 'move' : response === 2 ? 'never' : 'not-now'
}

/** Once per process, offers to move a macOS build that runs from a disk image, Downloads, or a translocated path. */
export async function presentApplicationsFolderMovePrompt(window: BrowserWindow): Promise<void> {
  const store = state.store
  if (offeredThisProcess || !store || window.isDestroyed() || state.isQuitting) {
    return
  }
  const eligible = shouldOfferApplicationsFolderMove({
    platform: process.platform,
    isPackaged: app.isPackaged,
    isServeMode: state.isServeMode,
    isAutomatedLaunch: isBackgroundLaunch() || process.env.ORCA_E2E_USER_DATA_DIR !== undefined,
    offerEnabled: store.getSettings().offerMoveToApplicationsFolder !== false,
    onboardingOpen: store.getOnboarding().closedAt === null,
    isInApplicationsFolder: () => app.isInApplicationsFolder()
  })
  if (!eligible) {
    return
  }
  offeredThisProcess = true
  await handleApplicationsFolderMoveOffer({
    prompt: () => promptForApplicationsFolderMove(window),
    isQuitting: () => state.isQuitting,
    optOut: () => {
      store.updateSettings({ offerMoveToApplicationsFolder: false }, { notifyListeners: true })
    },
    // The conflict handler must answer synchronously, so its dialogs are sync too.
    move: () =>
      app.moveToApplicationsFolder({
        conflictHandler: (conflict) =>
          resolveApplicationsFolderMoveConflict(conflict, {
            confirmReplace: () => showMessageBoxSync(window, replaceExistingCopyOptions()) === 0,
            explainRunningCopy: () => {
              showMessageBoxSync(window, runningCopyOptions())
            }
          })
      }),
    onPromptFailed: (error) =>
      console.warn('[applications-folder-move] failed to show prompt:', error),
    onMoveFailed: (error) => {
      console.warn(
        '[applications-folder-move] move failed:',
        error instanceof Error ? error.message : typeof error
      )
      showMessageBoxSync(window, moveFailedOptions())
    }
  })
}
