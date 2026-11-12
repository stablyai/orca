import { randomUUID } from 'node:crypto'
import {
  app,
  dialog,
  ipcMain,
  type BrowserWindow,
  type IpcMainEvent,
  type MessageBoxOptions
} from 'electron'
import { translateMain } from '../i18n/main-i18n'
import { isBackgroundLaunch } from '../window/foreground-activation-policy'
import { mainProcessState as state } from './main-process-state'
import {
  handleApplicationsFolderMoveOffer,
  resolveApplicationsFolderMoveConflict,
  runApplicationsFolderMove,
  shouldOfferApplicationsFolderMove,
  type ApplicationsFolderMoveDecision
} from './applications-folder-move-decision'

const MOVE_CHANNEL = 'applicationsFolderMove:move'
const PREPARE_FAILED_CHANNEL = 'applicationsFolderMove:prepareFailed'

let offeredThisProcess = false

function movePromptOptions(): MessageBoxOptions {
  return {
    type: 'question',
    buttons: [
      translateMain('applicationsFolderMove.prompt.moveButton', 'Move and Relaunch'),
      translateMain('applicationsFolderMove.prompt.notNowButton', 'Not Now'),
      translateMain('applicationsFolderMove.prompt.neverButton', 'Don’t Ask Again')
    ],
    // Shown right after launch while the user may be typing; Return must not quit and move the app.
    defaultId: 1,
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
    // Replacing trashes the other copy, so Return keeps it.
    defaultId: 1,
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

function reportMoveFailure(window: BrowserWindow, error: unknown): void {
  console.warn(
    '[applications-folder-move] move failed:',
    error instanceof Error ? error.message : typeof error
  )
  showMessageBoxSync(window, moveFailedOptions())
}

/** On success Electron has already begun quitting through app.quit() to reopen the moved copy. */
function moveToApplicationsFolder(window: BrowserWindow): boolean {
  try {
    return runApplicationsFolderMove({
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
      onMoveFailed: (error) => reportMoveFailure(window, error)
    })
  } catch (error) {
    console.warn('[applications-folder-move] failed to report move failure:', error)
    return false
  }
}

/** Electron deletes a non-DMG original before quitting, so the renderer stands its quit guards down and backs up dirty buffers first, as for an update restart. */
function requestRendererPreparedMove(window: BrowserWindow): void {
  const contents = window.webContents
  if (window.isDestroyed() || contents.isDestroyed()) {
    // No renderer remains to back up buffers or veto the quit.
    moveToApplicationsFolder(window)
    return
  }
  const token = randomUUID()
  const release = (): void => {
    ipcMain.removeHandler(MOVE_CHANNEL)
    ipcMain.removeListener(PREPARE_FAILED_CHANNEL, onPrepareFailed)
  }
  const onPrepareFailed = (event: IpcMainEvent, failedToken: unknown): void => {
    if (event.sender.id !== contents.id || failedToken !== token) {
      return
    }
    release()
    reportMoveFailure(window, new Error('Renderer restart preparation failed'))
  }
  ipcMain.removeHandler(MOVE_CHANNEL)
  ipcMain.handle(MOVE_CHANNEL, (event, requestToken: unknown): boolean => {
    if (event.sender.id !== contents.id || requestToken !== token) {
      return false
    }
    release()
    const moved = moveToApplicationsFolder(window)
    if (moved && !contents.isDestroyed()) {
      // As for a committed profile switch: a late veto must not re-arm guards for a bundle that is gone.
      contents.send('app:restart-committed')
    }
    return moved
  })
  ipcMain.on(PREPARE_FAILED_CHANNEL, onPrepareFailed)
  contents.send('applicationsFolderMove:begin', token)
}

async function offerApplicationsFolderMove(window: BrowserWindow): Promise<void> {
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
    requestMove: () => requestRendererPreparedMove(window),
    onPromptFailed: (error) =>
      console.warn('[applications-folder-move] failed to show prompt:', error),
    onMoveFailed: (error) => reportMoveFailure(window, error)
  })
}

/** Once per process, offers to move a macOS build that runs from a disk image, Downloads, or a translocated path. Never rejects. */
export async function presentApplicationsFolderMovePrompt(window: BrowserWindow): Promise<void> {
  try {
    await offerApplicationsFolderMove(window)
  } catch (error) {
    // Startup keeps running; a failed offer only costs this launch's prompt.
    console.warn('[applications-folder-move] failed to offer move:', error)
  }
}
