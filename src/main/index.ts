import { app, type BrowserWindow } from 'electron'
import { parseSkillShareId } from '../shared/skill-share-link'
import { createMacAppActivationHandler } from './window/macos-app-activation'
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
  // Why: a duplicate `orca serve` must not drag a headless server into opening a desktop window (#11935).
  if (!shouldActivateDesktopForSecondInstance(argv)) {
    return
  }
  state.desktopActivationGate?.requestActivation()
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
  state.skillShareDeepLinks.capture(process.argv)
  registerMainProcessIpcHandlers()
  installMainProcessQuitHandlers()
  void app.whenReady().then(async () => {
    await initializeMainProcessReady({
      openMainWindow,
      handleMacAppActivation
    })
  })
}
