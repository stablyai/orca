import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import {
  app,
  dialog,
  ipcMain,
  type BrowserWindow,
  type IpcMainEvent,
  type MessageBoxOptions
} from 'electron'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/breadcrumbs/durable-crash-breadcrumb'
import { preserveAgentAuthBeforeRestart } from '../providers/accounts/agent-auth-restart-preservation'
import { getUpdateStatus } from '../updater/updater-service'
import { isBackgroundLaunch } from '../window/foreground-activation-policy'
import { mainProcessState as state } from './main-process-state'
import {
  cannotReplaceCopyOptions,
  moveFailedOptions,
  movePromptOptions,
  replaceExistingCopyOptions,
  runningCopyOptions
} from './applications-folder-move-dialogs'
import { runBeforeRelaunchCleanup } from './quit/app-relaunch'
import {
  createApplicationsFolderMoveRequest,
  handleApplicationsFolderMoveOffer,
  moveWouldDeleteExistingCopyUnasked,
  resolveApplicationsFolderMoveConflict,
  runApplicationsFolderMove,
  shouldOfferApplicationsFolderMove,
  type ApplicationsFolderMoveDecision,
  type ApplicationsFolderMoveDestination
} from './applications-folder-move-decision'

const MOVE_CHANNEL = 'applicationsFolderMove:move'
const PREPARE_FAILED_CHANNEL = 'applicationsFolderMove:prepareFailed'
// Covers the hot-exit backup and durable checkpoint on a slow host; past it a hung renderer must not move the app later.
const RENDERER_PREPARE_TIMEOUT_MS = 30_000

let offeredThisProcess = false

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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : typeof error
}

/** Never throws: it runs from timers and IPC handlers. */
function reportMoveFailure(window: BrowserWindow, error: unknown): void {
  console.warn('[applications-folder-move] move failed:', describeError(error))
  try {
    showMessageBoxSync(window, moveFailedOptions())
  } catch (dialogError) {
    console.warn(
      '[applications-folder-move] failed to report move failure:',
      describeError(dialogError)
    )
  }
}

async function canAccess(path: string, mode: number): Promise<boolean> {
  try {
    await access(path, mode)
    return true
  } catch {
    return false
  }
}

/** Mirrors where Electron's mover installs: the local Applications folder plus this bundle's name. */
async function readMoveDestination(): Promise<ApplicationsFolderMoveDestination> {
  const applicationsFolder = '/Applications'
  // exe is <bundle>.app/Contents/MacOS/<name>.
  const bundleName = basename(resolve(app.getPath('exe'), '..', '..', '..'))
  const destination = join(applicationsFolder, bundleName)
  const [exists, writable, applicationsFolderWritable] = await Promise.all([
    canAccess(destination, constants.F_OK),
    canAccess(destination, constants.W_OK),
    canAccess(applicationsFolder, constants.W_OK)
  ])
  return { exists, writable, applicationsFolderWritable }
}

function isUpdateDownloadingOrStaged(): boolean {
  const updateState = getUpdateStatus().state
  return updateState === 'downloading' || updateState === 'downloaded'
}

/** Resolves true once Electron has moved the bundle and begun quitting through app.quit() to reopen it. Never rejects. */
async function moveToApplicationsFolder(window: BrowserWindow): Promise<boolean> {
  try {
    // Electron reports success without moving or quitting when the bundle is already installed.
    if (state.isQuitting || app.isInApplicationsFolder()) {
      return false
    }
    if (isUpdateDownloadingOrStaged()) {
      // A pending install targets this bundle's current path and can defer the quit.
      reportMoveFailure(window, new Error('An update is downloading or staged'))
      return false
    }
    if (moveWouldDeleteExistingCopyUnasked(await readMoveDestination())) {
      showMessageBoxSync(window, cannotReplaceCopyOptions())
      return false
    }
    // Same auth and store preservation as other restarts; harmless if the move is then declined.
    await runBeforeRelaunchCleanup(() =>
      preserveAgentAuthBeforeRestart({
        codexRuntimeHome: state.codexRuntimeHome,
        store: state.store
      })
    )
    // A quit that began during the awaits above must not be joined by a move.
    if (state.isQuitting) {
      return false
    }
    recordDurableCrashBreadcrumb('applications_folder_move_requested')
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
    console.warn('[applications-folder-move] move failed unexpectedly:', describeError(error))
    return false
  }
}

/** Electron deletes a non-DMG original before quitting, so the renderer stands its quit guards down and backs up dirty buffers first, as for an update restart. */
function requestRendererPreparedMove(window: BrowserWindow): void {
  if (window.isDestroyed() || window.webContents.isDestroyed()) {
    // No renderer remains to back up buffers or veto the quit.
    void moveToApplicationsFolder(window)
    return
  }
  const contents = window.webContents
  const token = randomUUID()
  const request = createApplicationsFolderMoveRequest(contents.id, token)
  const release = (): void => {
    clearTimeout(deadline)
    ipcMain.removeHandler(MOVE_CHANNEL)
    ipcMain.removeListener(PREPARE_FAILED_CHANNEL, onPrepareFailed)
  }
  const onPrepareFailed = (event: IpcMainEvent, failedToken: unknown): void => {
    if (!request.settle(event.sender.id, failedToken)) {
      return
    }
    release()
    reportMoveFailure(window, new Error('Renderer restart preparation failed'))
  }
  // A hung, crashed or reloaded renderer must not trigger the move minutes later.
  const deadline = setTimeout(() => {
    if (!request.expire()) {
      return
    }
    release()
    reportMoveFailure(window, new Error('Renderer did not prepare for the move in time'))
  }, RENDERER_PREPARE_TIMEOUT_MS)
  ipcMain.removeHandler(MOVE_CHANNEL)
  ipcMain.handle(MOVE_CHANNEL, async (event, answerToken: unknown): Promise<boolean> => {
    if (!request.settle(event.sender.id, answerToken)) {
      return false
    }
    release()
    const moved = await moveToApplicationsFolder(window)
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
  // Like the other startup dialogs, wait for i18n so the prompt is not stuck in the English fallback.
  await state.mainProcessI18nReady
  await handleApplicationsFolderMoveOffer({
    prompt: () => promptForApplicationsFolderMove(window),
    isQuitting: () => state.isQuitting,
    optOut: () => {
      store.updateSettings({ offerMoveToApplicationsFolder: false }, { notifyListeners: true })
    },
    requestMove: () => requestRendererPreparedMove(window),
    onPromptFailed: (error) =>
      console.warn('[applications-folder-move] failed to show prompt:', describeError(error)),
    onMoveFailed: (error) => reportMoveFailure(window, error)
  })
}

/** Once per process, offers to move a macOS build that runs from a disk image, Downloads, or a translocated path. Never rejects. */
export async function presentApplicationsFolderMovePrompt(window: BrowserWindow): Promise<void> {
  try {
    await offerApplicationsFolderMove(window)
  } catch (error) {
    // Startup keeps running; a failed offer only costs this launch's prompt.
    console.warn('[applications-folder-move] failed to offer move:', describeError(error))
  }
}
