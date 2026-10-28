import { app, clipboard, dialog, type BrowserWindow } from 'electron'
import { parseSkillShareId } from '../shared/skill-share-link'
import { createMacAppActivationHandler } from './window/macos-app-activation'
import { isBackgroundLaunch, isOrcadSidecarLaunch } from './window/foreground-activation-policy'
import { createDesktopHandoff, desktopHandoffArguments } from './window/macos-desktop-handoff'
import {
  focusExistingWindow as focusExistingWindowAction,
  setMainWindowOpener
} from './startup/main-window-actions'
import { openMainWindow as openMainWindowController } from './startup/main-window-controller'
import { mainProcessState as state } from './startup/main-process-state'
import { runMainProcessPreflight } from './startup/main-process-preflight'
import { runWslHolderUninstallPreflight } from './startup/wsl-holder-uninstall-preflight'
import { enableLinearRegexpFallback } from './startup/linear-regexp-fallback'
import { registerMainProcessIpcHandlers } from './startup/main-process-ipc-bootstrap'
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
  chooseProfileStateRepair,
  presentProfileStateStartupRecoveryDialog,
  readProfileStateCopySavedTimes
} from './persistence/profile-state/profile-state-startup-recovery-dialog'
import { profileStateDesktopRecoveryArgs } from './startup/profile-state-recovery-preflight'
import { prepareEarlyMainUiLanguage, translateMain } from './i18n/main-i18n'
import { ProfileStateRecoveryRequiredError } from './persistence/profile-state/profile-state-recovery-required'
import { getProfileUserDataPath } from './orca-profiles/profile-storage-paths'
import { leaseAppImageGenerationForCurrentProcess } from './cli/appimage-generation-lease'
import { wakeRememberedWslHosts } from './wsl/wsl-host-early-wake'
import { wslHostsServing } from './wsl/wsl-host-gate'
import { configureWslHostsGateFromDisk } from './wsl/wsl-host-gate-startup'

function openMainWindow(options: { revealOnDidFinishLoad?: boolean } = {}): BrowserWindow {
  return openMainWindowController(options)
}

setMainWindowOpener(openMainWindow)

function focusExistingWindow(): void {
  focusExistingWindowAction()
}

const requestDesktopHandoff = createDesktopHandoff({
  drainArguments: () => desktopHandoffArguments(state)
})

function requestDesktopActivation(argv: readonly string[] = []): void {
  state.skillShareDeepLinks.capture(argv, (shareId) => {
    state.mainWindow?.webContents.send('ui:openSkillShare', shareId)
  })
  state.osOpenedDocuments.capture(argv, publishOsOpenedDocuments)
  // Duplicate serve launches must not activate a desktop on a headless server (#11935).
  if (!shouldActivateDesktopForSecondInstance(argv)) {
    return
  }
  // The sidecar’s throwaway profile must never become the user’s window.
  if (isOrcadSidecarLaunch()) {
    requestDesktopHandoff()
    return
  }
  state.desktopActivationGate?.requestActivation()
}

/** Buffer documents until listener readiness; webContents.send silently drops unhandled messages. */
function publishOsOpenedDocuments(): void {
  const targetWindow = state.mainWindow
  if (!state.osDocumentOpenListenerReady || !targetWindow || targetWindow.isDestroyed()) {
    return
  }
  // Consume before awaiting to prevent duplicate renderer pulls; restore if delivery fails.
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

// The uninstaller's holder release runs instead of the app, never alongside it.
const preflightReady =
  !runWslHolderUninstallPreflight() &&
  runMainProcessPreflight({
    focusExistingWindow,
    requestDesktopActivation
  })

// Skip userData writes after losing the single-instance lock.
if (preflightReady) {
  enableLinearRegexpFallback()
  void leaseAppImageGenerationForCurrentProcess()
  // Before any gate check: saved WSL work keeps a closed gate serving it.
  configureWslHostsGateFromDisk(app.getPath('userData'))
  // Why this early: a cold distro takes seconds to boot; starting now overlaps it with app startup.
  if (process.platform === 'win32' && wslHostsServing()) {
    wakeRememberedWslHosts(app.getPath('userData'))
  }
  app.on('open-url', (event, url) => {
    if (!parseSkillShareId(url)) {
      return
    }
    event.preventDefault()
    requestDesktopActivation([url])
  })
  // macOS can deliver Open With before ready; claim only supported paths.
  app.on('open-file', (event, filePath) => {
    if (!state.osOpenedDocuments.captureFilePaths([filePath], publishOsOpenedDocuments)) {
      return
    }
    event.preventDefault()
    // Cold-start activation must wait for Electron readiness; sidecars have no pending window.
    if (app.isReady() || isOrcadSidecarLaunch()) {
      requestDesktopActivation()
    }
  })
  state.skillShareDeepLinks.capture(process.argv)
  // The first renderer pulls on mount; nothing listens this early.
  state.osOpenedDocuments.capture(process.argv)
  registerMainProcessIpcHandlers()
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
          await prepareEarlyMainUiLanguage()
          const userDataPath = getProfileUserDataPath()
          if (isDivergedProfileStateFailure(error)) {
            const choice = await chooseProfileStateCopy({
              ...readProfileStateCopySavedTimes(userDataPath),
              showMessageBox: (options) => dialog.showMessageBox(options),
              translate: translateMain
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
          if (
            error instanceof ProfileStateRecoveryRequiredError &&
            error.repairableSections !== undefined
          ) {
            const sections = error.repairableSections
            if (
              await chooseProfileStateRepair({
                sections,
                showMessageBox: (options) => dialog.showMessageBox(options),
                translate: translateMain
              })
            ) {
              app.relaunch({
                args: profileStateDesktopRecoveryArgs(process.argv, {
                  userDataPath,
                  profileId: error.profileId,
                  selector: {
                    kind: 'repair',
                    sections: sections.map(({ domain, backupId }) => ({ domain, backupId }))
                  }
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
            copyToClipboard: (text) => clipboard.writeText(text),
            translate: translateMain
          })
        } catch (dialogError) {
          console.warn('[profile-state] Recovery dialog failed; exiting safely:', dialogError)
        }
      }
      app.exit(1)
    }
  })
}
