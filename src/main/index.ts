import { app, clipboard, dialog, type BrowserWindow } from 'electron'
import { isRoutedOrcaDeepLink } from './startup/open-routing/orca-deep-link-url'
import { createMacAppActivationHandler } from './window/activation/macos-app-activation'
import {
  isBackgroundLaunch,
  isOrcadSidecarLaunch
} from './window/activation/foreground-activation-policy'
import {
  createDesktopHandoff,
  desktopHandoffArguments
} from './window/activation/macos-desktop-handoff'
import {
  focusExistingWindow as focusExistingWindowAction,
  setMainWindowOpener
} from './startup/main-window/main-window-actions'
import { openMainWindow as openMainWindowController } from './startup/main-window/main-window-controller'
import { mainProcessState as state } from './startup/main-process-state'
import { runMainProcessPreflight } from './startup/main-process-preflight'
import { runWslHolderUninstallPreflight } from './startup/uninstall/wsl-holder-uninstall-preflight'
import { runAgentHooksUninstallPreflight } from './startup/uninstall/agent-hooks-uninstall-preflight'
import { enableLinearRegexpFallback } from './startup/chromium-policy/linear-regexp-fallback'
import { ensureWindowsRendererRuntimeFiles } from './startup/windows-startup/windows-renderer-runtime-files'
import { registerMainProcessIpcHandlers } from './startup/main-process-ipc-bootstrap'
import { initializeMainProcessReady } from './startup/main-process-ready'
import { installMainProcessQuitHandlers } from './startup/quit/main-process-quit'
import { installNotchStatus } from './startup/notch-status-wiring'
import { shouldActivateDesktopForSecondInstance } from './startup/profile-startup/single-instance-lock'
import { resolveOsOpenedDocuments } from './startup/open-routing/os-opened-documents'
import {
  formatProfileStateStartupFailure,
  isDivergedProfileStateFailure,
  profileStateStartupFailureClass
} from './persistence/profile-state/startup/profile-state-startup-failure'
import { recordDurableCrashBreadcrumb } from './crash-reporting/breadcrumbs/durable-crash-breadcrumb'
import {
  chooseProfileStateCopy,
  chooseProfileStateRepair,
  presentProfileStateStartupRecoveryDialog,
  readProfileStateCopySavedTimes
} from './persistence/profile-state/startup/profile-state-startup-recovery-dialog'
import { profileStateDesktopRecoveryArgs } from './startup/profile-startup/profile-state-recovery-preflight'
import { profileStateRepairSectionApproval } from '../shared/profile-state-recovery-command'
import { prepareEarlyMainUiLanguage, translateMain } from './i18n/main-i18n'
import { ProfileStateRecoveryRequiredError } from './persistence/profile-state/recovery/profile-state-recovery-required'
import { getProfileUserDataPath } from './orca-profiles/profile-storage-paths'
import { leaseAppImageGenerationForCurrentProcess } from './cli/appimage/appimage-generation-lease'
import { deleteLegacyWslHostWakeList } from './wsl/host-lifecycle/wsl-host-early-wake'
import { configureWslHostsGateFromDisk } from './wsl/host-lifecycle/wsl-host-gate-startup'
import { configureRemoteRuntimeE2EEV2HostLatch } from '../shared/remote-runtime/e2ee/node/remote-runtime-e2ee-v2-host-latch'
import { ignoreInheritedWslHostsGateState } from '../shared/wsl-host-internal-gate'
import { registerOrcaProtocolClient } from './startup/open-routing/orca-protocol-registration'
import { clearWindowsStdHandleInheritance } from './startup/windows-startup/windows-std-handle-inheritance'
import { installWindowsIsolatedSpawner } from './startup/windows-startup/windows-isolated-spawner'
import { dropE2eSpawnLogOutsideE2e } from './startup/testing/e2e-spawn-log-env'
import type { MainWindowOpenOptions } from './window/main-window/main-window-contracts'
import type { DesktopActivationRequest } from './startup/serve-launch/serve-desktop-activation'
import { argvRequestsBackgroundOpen, BACKGROUND_OPEN_ARG } from '../shared/background-open-argv'
import { setBackgroundWindowOpener } from './window/activation/background-window-open'

// Before anything spawns, so no daemon, PTY or agent inherits it outside e2e.
dropE2eSpawnLogOutsideE2e()

function openMainWindow(options: MainWindowOpenOptions = {}): BrowserWindow {
  return openMainWindowController(options)
}

setMainWindowOpener(openMainWindow)
setBackgroundWindowOpener(() => requestDesktopActivation([BACKGROUND_OPEN_ARG]))

function focusExistingWindow(request: DesktopActivationRequest = {}): void {
  focusExistingWindowAction(request)
}

const requestDesktopHandoff = createDesktopHandoff({
  drainArguments: () => desktopHandoffArguments(state)
})

function requestDesktopActivation(argv: readonly string[] = []): void {
  state.skillShareDeepLinks.capture(argv, (shareId) => {
    state.mainWindow?.webContents.send('ui:openSkillShare', shareId)
  })
  state.pluginInstallLinks.capture(argv, (link) => {
    state.mainWindow?.webContents.send('ui:openPluginInstallLink', link)
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
  state.desktopActivationGate?.requestActivation({
    background: argvRequestsBackgroundOpen(argv)
  })
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

// Before anything spawns: no child may inherit Orca's std handles.
clearWindowsStdHandleInheritance()
installWindowsIsolatedSpawner()
// A relaunch or installer inherits the parent's published WSL gate state; this process recomputes.
ignoreInheritedWslHostsGateState()
// The uninstaller's holder release and hook removal run instead of the app, never alongside it.
const preflightReady =
  !runWslHolderUninstallPreflight() &&
  !runAgentHooksUninstallPreflight() &&
  runMainProcessPreflight({
    focusExistingWindow,
    requestDesktopActivation
  }) &&
  ensureWindowsRendererRuntimeFiles(state.isServeMode)

// Skip userData writes after losing the single-instance lock.
if (preflightReady) {
  enableLinearRegexpFallback()
  void leaseAppImageGenerationForCurrentProcess()
  // Before any gate check: saved WSL work keeps a closed gate serving it.
  configureWslHostsGateFromDisk(app.getPath('userData'), app.getVersion())
  configureRemoteRuntimeE2EEV2HostLatch(app.getPath('userData'))
  // A launch restore is passive (E9): it never boots a WSL host's distro, so drop the old wake list.
  if (process.platform === 'win32') {
    deleteLegacyWslHostWakeList(app.getPath('userData'))
  }
  app.on('open-url', (event, url) => {
    if (!isRoutedOrcaDeepLink(url)) {
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
  registerOrcaProtocolClient(app, {
    platform: process.platform,
    desktopLaunch: !state.isServeMode && !isBackgroundLaunch() && !isOrcadSidecarLaunch()
  })
  state.skillShareDeepLinks.capture(process.argv)
  state.pluginInstallLinks.capture(process.argv)
  // The first renderer pulls on mount; nothing listens this early.
  state.osOpenedDocuments.capture(process.argv)
  registerMainProcessIpcHandlers()
  installMainProcessQuitHandlers()
  installNotchStatus({ openMainWindow })
  void app.whenReady().then(async () => {
    try {
      await initializeMainProcessReady({
        openMainWindow,
        handleMacAppActivation
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const message =
        formatProfileStateStartupFailure(error) ?? `Orca could not finish starting: ${detail}`
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
                    sections: sections.map(profileStateRepairSectionApproval)
                  }
                })
              })
            }
            app.exit(1)
            return
          }
          await presentProfileStateStartupRecoveryDialog({
            message:
              formatProfileStateStartupFailure(error, translateMain) ??
              translateMain(
                'startupFailure.finishFailed',
                'Orca could not finish starting: {{detail}}',
                { detail }
              ),
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
