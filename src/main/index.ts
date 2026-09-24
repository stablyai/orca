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
import { initializeMainProcessReady } from './startup/main-process-ready'
import { installMainProcessQuitHandlers } from './startup/main-process-quit'
import { shouldActivateDesktopForSecondInstance } from './startup/single-instance-lock'
import { resolveOpenedMarkdownDocuments } from './startup/os-opened-markdown-files'
import {
  formatProfileStateStartupFailure,
  profileStateStartupFailureClass
} from './persistence/profile-state/profile-state-startup-failure'
import { recordDurableCrashBreadcrumb } from './crash-reporting/durable-crash-breadcrumb'
import { presentProfileStateStartupRecoveryDialog } from './persistence/profile-state/profile-state-startup-recovery-dialog'

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
  state.osOpenedMarkdownFiles.capture(argv, publishOsOpenedMarkdownFiles)
  // Why: a duplicate `orca serve` must not drag a headless server into opening a desktop window (#11935).
  if (!shouldActivateDesktopForSecondInstance(argv)) {
    return
  }
  state.desktopActivationGate?.requestActivation()
}

/**
 * Hands buffered OS-opened markdown paths to a renderer that has proven it is listening.
 *
 * Until that proof arrives the paths stay buffered, because `webContents.send` to a renderer
 * with no listener attached is dropped silently and the queue would be gone.
 */
function publishOsOpenedMarkdownFiles(): void {
  const targetWindow = state.mainWindow
  if (!state.markdownFileOpenListenerReady || !targetWindow || targetWindow.isDestroyed()) {
    return
  }
  // Why consumed before the await: a renderer pull racing this resolve must not take the same
  // batch again. The restore() calls hand it back if delivery turns out to be impossible.
  const filePaths = state.osOpenedMarkdownFiles.consume()
  if (filePaths.length === 0) {
    return
  }
  void resolveOpenedMarkdownDocuments(filePaths)
    .then((documents) => {
      if (targetWindow.isDestroyed() || targetWindow.webContents.isDestroyed()) {
        state.osOpenedMarkdownFiles.restore(filePaths)
        return
      }
      if (documents.length > 0) {
        targetWindow.webContents.send('ui:openMarkdownFiles', documents)
      }
    })
    .catch((error) => {
      state.osOpenedMarkdownFiles.restore(filePaths)
      console.warn('[os-open] Failed to resolve OS-opened markdown files:', error)
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
  // that claims the event. Non-markdown paths stay unclaimed so the OS default handler wins.
  app.on('open-file', (event, filePath) => {
    if (!state.osOpenedMarkdownFiles.captureFilePaths([filePath], publishOsOpenedMarkdownFiles)) {
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
  state.osOpenedMarkdownFiles.capture(process.argv)
  registerMainProcessIpcHandlers()
  installMainProcessQuitHandlers()
  void app.whenReady().then(async () => {
    try {
      await initializeMainProcessReady({
        openMainWindow,
        handleMacAppActivation
      })
    } catch (error) {
      const message = formatProfileStateStartupFailure(error)
      if (message === undefined) {
        throw error
      }
      const failureClass = profileStateStartupFailureClass(error)
      if (failureClass !== undefined) {
        recordDurableCrashBreadcrumb('profile_state_startup_failed', {
          failure_class: failureClass
        })
      }
      console.error(`[profile-state] ${message}`)
      if (!state.isServeMode && !isBackgroundLaunch()) {
        try {
          await presentProfileStateStartupRecoveryDialog({
            message,
            ...(failureClass === 'recovery-required'
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
