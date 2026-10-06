import { app, clipboard, dialog, type BrowserWindow } from 'electron'
import { parseSkillShareId } from '../shared/skill-share-link'
import { createMacAppActivationHandler } from './window/macos-app-activation'
import { isBackgroundLaunch } from './window/foreground-activation-policy'
import {
  focusExistingWindow as focusExistingWindowAction,
  setMainWindowOpener
} from './startup/main-window-actions'
import { openMainWindow as openMainWindowController } from './startup/main-window-controller'
import { mainProcessState as state } from './startup/main-process-state'
import { runMainProcessPreflight } from './startup/main-process-preflight'
import { registerMainProcessIpcHandlers } from './startup/main-process-ipc-bootstrap'
import {
  registerPowerShellHostResolutionBreadcrumb,
  warmPowerShellHostInBackground
} from './crash-reporting/powershell-host-resolution-breadcrumb'
import { initializeMainProcessReady } from './startup/main-process-ready'
import { installMainProcessQuitHandlers } from './startup/main-process-quit'
import { shouldActivateDesktopForSecondInstance } from './startup/single-instance-lock'
import { resolveOsOpenedDocuments } from './startup/os-opened-documents'
import {
  formatProfileStateStartupFailure,
  isDivergedProfileStateFailure,
  profileStateStartupFailureClass
} from './persistence/profile-state/profile-state-startup-failure'
import { recordDurableCrashBreadcrumb } from './crash-reporting/durable-crash-breadcrumb'
import {
  chooseProfileStateCopy,
  presentProfileStateStartupRecoveryDialog,
  readProfileStateCopySavedTimes
} from './persistence/profile-state/profile-state-startup-recovery-dialog'
import { profileStateDesktopRecoveryArgs } from './startup/profile-state-recovery-preflight'

function openMainWindow(options: { revealOnDidFinishLoad?: boolean } = {}): BrowserWindow {
  return openMainWindowController(options)
}

setMainWindowOpener(openMainWindow)

function focusExistingWindow(): void {
  focusExistingWindowAction()
}

function requestDesktopActivation(argv: readonly string[] = []): void {
  state.skillShareDeepLinks.capture(argv, (shareId) => {
    state.mainWindow?.webContents.send('ui:openSkillShare', shareId)
  })
  state.osOpenedDocuments.capture(argv, publishOsOpenedDocuments)
  // Why: a duplicate `orca serve` must not drag a headless server into opening a desktop window (#11935).
  if (!shouldActivateDesktopForSecondInstance(argv)) {
    return
  }
  state.desktopActivationGate?.requestActivation()
}

/**
 * Hands buffered OS-opened document paths to a renderer that has proven it is listening.
 *
 * Until that proof arrives the paths stay buffered, because `webContents.send` to a renderer
 * with no listener attached is dropped silently and the queue would be gone.
 */
function publishOsOpenedDocuments(): void {
  const targetWindow = state.mainWindow
  if (!state.osDocumentOpenListenerReady || !targetWindow || targetWindow.isDestroyed()) {
    return
  }
  // Why consumed before the await: a renderer pull racing this resolve must not take the same
  // batch again. The restore() calls hand it back if delivery turns out to be impossible.
  const filePaths = state.osOpenedDocuments.consume()
  if (filePaths.length === 0) {
    return
  }
  void resolveOsOpenedDocuments(filePaths)
    .then((documents) => {
      if (targetWindow.isDestroyed() || targetWindow.webContents.isDestroyed()) {
        state.osOpenedDocuments.restore(filePaths)
        return
      }
      if (documents.length > 0) {
        targetWindow.webContents.send('ui:openMarkdownFiles', documents)
      }
    })
    .catch((error) => {
      state.osOpenedDocuments.restore(filePaths)
      console.warn('[os-open] Failed to resolve OS-opened documents:', error)
    })
}

const handleMacAppActivation = createMacAppActivationHandler({
  getWindow: () => state.mainWindow,
  requestActivation: requestDesktopActivation
})

const preflightReady = runMainProcessPreflight({
  focusExistingWindow,
  requestDesktopActivation
})

// Why: when another process holds the lock we've already exited; skip file-writing side effects so this transient process never touches userData.
if (preflightReady) {
  app.on('open-url', (event, url) => {
    if (!parseSkillShareId(url)) {
      return
    }
    event.preventDefault()
    requestDesktopActivation([url])
  })
  // Why: macOS delivers "Open With" as open-file, often before `ready`, and only to a handler
  // that claims the event. Unsupported paths stay unclaimed.
  app.on('open-file', (event, filePath) => {
    if (!state.osOpenedDocuments.captureFilePaths([filePath], publishOsOpenedDocuments)) {
      return
    }
    event.preventDefault()
    // Why gated on isReady: pre-ready the cold-start window is already on its way, and
    // activating the gate here would try to open one before Electron can.
    if (app.isReady()) {
      requestDesktopActivation()
    }
  })
  state.skillShareDeepLinks.capture(process.argv)
  // Why no publish: nothing is listening this early, so the first renderer pulls these on mount.
  state.osOpenedDocuments.capture(process.argv)
  registerMainProcessIpcHandlers()
  registerPowerShellHostResolutionBreadcrumb()
  warmPowerShellHostInBackground()
  installMainProcessQuitHandlers()
  void app.whenReady().then(async () => {
    try {
      await initializeMainProcessReady({
        openMainWindow,
        handleMacAppActivation
      })
    } catch (error) {
      const message =
        formatProfileStateStartupFailure(error) ??
        `Orca could not finish starting: ${error instanceof Error ? error.message : String(error)}`
      const failureClass = profileStateStartupFailureClass(error)
      if (failureClass !== undefined) {
        recordDurableCrashBreadcrumb('profile_state_startup_failed', {
          failure_class: failureClass
        })
      }
      console.error(`[profile-state] ${message}`)
      if (!state.isServeMode && !isBackgroundLaunch()) {
        try {
          if (isDivergedProfileStateFailure(error)) {
            const userDataPath = app.getPath('userData')
            const choice = await chooseProfileStateCopy({
              ...readProfileStateCopySavedTimes(userDataPath),
              showMessageBox: (options) => dialog.showMessageBox(options)
            })
            if (choice !== undefined) {
              // Recovery needs both profile locks, which only a fresh process can own safely.
              app.relaunch({
                args: profileStateDesktopRecoveryArgs(process.argv, {
                  userDataPath,
                  selector: { kind: choice }
                })
              })
            }
            app.exit(1)
            return
          }
          await presentProfileStateStartupRecoveryDialog({
            message,
            ...(failureClass === 'recovery-required' || failureClass === 'ambiguous-authority'
              ? { recoveryCommand: 'orca profile state exports' }
              : {}),
            showMessageBox: (options) => dialog.showMessageBox(options),
            copyToClipboard: (text) => clipboard.writeText(text)
          })
        } catch (dialogError) {
          console.warn('[profile-state] Recovery dialog failed; exiting safely:', dialogError)
        }
      }
      app.exit(1)
    }
  })
}
