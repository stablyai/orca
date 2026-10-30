import {
  app,
  clipboard,
  dialog,
  type BrowserWindow,
  type MessageBoxOptions,
  type MessageBoxReturnValue,
  type Tray,
  type WebContents
} from 'electron'
import { isNativeBrowserPopupWindow } from '../browser/native-browser-popup-windows'
import type { UpdateCheckOptions } from '../../shared/update-status-types'
import type { AppMenuQuitHandlers } from '../menu/app-menu-quit-item'
import type { createWebContentsTimedFlag } from './web-contents-timed-flag'
import { recordCrashBreadcrumb } from '../crash-reporting/crash-breadcrumb-store'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/durable-crash-breadcrumb'
import { checkForUpdatesFromMenu, isQuittingForUpdate } from '../updater'
import {
  createSystemTray,
  setMacMenuBarIconVisible,
  type SystemTrayOptions
} from '../tray/system-tray'
import { ensureAutoUpdaterConfigured } from '../window/attach-main-window-services'
import { focusExistingMainWindow, safelyRevealWindow } from '../window/focus-existing-window'
import { mainProcessState as state } from './main-process-state'
import { getDashboardPopoutWindow } from '../window/dashboard-popout-window'
import { getWorkspaceSpaceWindow } from '../window/workspace-space-window'
import { markUserQuitWindowClose } from '../window/user-quit-window-close'
import { loadMainWindow } from '../window/createMainWindow'
import {
  describeInstallDirAclPoison,
  isBlockingInstallDirAclRepairInFlight
} from './windows-install-dir-acl-recovery'
import {
  presentRendererRecoveryPrompt,
  type RendererRecoveryPromptFailure
} from '../window/renderer-recovery-prompt'
import { probeRendererLaunchCapacity } from '../window/renderer-launch-failure-probe'
import {
  confirmQuitAndStopAllSessions,
  explainStopAllSessionsUnavailable
} from './quit-and-stop-all-sessions-prompt'
import { isHoldingForNewerProtocolDaemon } from '../daemon/daemon-newer-protocol-hold'
import { getDaemonProvider } from '../daemon/daemon-provider-state'
import { confirmNoDaemonSessionsRemain } from '../ipc/pty/pty-management'

// Inject the opener to avoid an actions/lifecycle import cycle.
let openWindow: (options?: { revealOnDidFinishLoad?: boolean }) => BrowserWindow
export function setMainWindowOpener(
  opener: (options?: { revealOnDidFinishLoad?: boolean }) => BrowserWindow
): void {
  openWindow = opener
}

export function focusExistingWindow(): void {
  focusExistingMainWindow({
    app,
    getWindow: () => state.mainWindow,
    openWindow,
    // Repair rewrites renderer DACLs; second-click activation during a blank launch must wait for the gated opener.
    canOpenWindow: () => !isBlockingInstallDirAclRepairInFlight(),
    warn: console.warn
  })
}

export function showMainWindowFromTray(): void {
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    safelyRevealWindow(state.mainWindow)
    return
  }
  if (!isQuittingForUpdate()) {
    openWindow()
  }
}

/** Shows the main window and sends it a one-shot intent, also queued for a renderer that mounts later. */
function sendOneShotToMainWindow(
  channel: string,
  pending: ReturnType<typeof createWebContentsTimedFlag>,
  durationMs: number
): boolean {
  showMainWindowFromTray()
  const targetWindow = state.mainWindow && !state.mainWindow.isDestroyed() ? state.mainWindow : null
  if (!targetWindow) {
    return false
  }
  pending.mark(targetWindow.webContents.id, durationMs)
  targetWindow.webContents.send(channel)
  return true
}

export function openSettingsFromSystemMenu(): void {
  if (
    sendOneShotToMainWindow('ui:openSettings', state.pendingOpenSettings, Number.POSITIVE_INFINITY)
  ) {
    recordCrashBreadcrumb('settings_opened')
  }
}

/** On serve, user Quit closes desktop windows while paired clients keep the server (#15537); signals/supervisor/updates still quit the process. */
export function quitFromUserCommand(): void {
  if (state.isServeMode) {
    // Offscreen automation windows belong to the runtime and must survive desktop-window close.
    for (const window of [state.mainWindow, getDashboardPopoutWindow()]) {
      if (window && !window.isDestroyed()) {
        if (window === state.mainWindow) {
          markUserQuitWindowClose(window)
        }
        window.close()
      }
    }
    return
  }
  state.isQuitting = true
  app.quit()
}

export function quitFromSystemTray(): void {
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    showMainWindowFromTray()
  }
  quitFromUserCommand()
}

// Why bounded: a renderer that never pulls the request must not stop sessions on a later reload.
const QUIT_AND_STOP_ALL_SESSIONS_REQUEST_TTL_MS = 30_000
let quitAndStopAllSessionsConfirming = false
// The renderer that consumed the request; only it may then ask main to quit.
let stoppingAllSessionsWebContentsId: number | null = null

function showMessageBoxOnMainWindow(options: MessageBoxOptions): Promise<MessageBoxReturnValue> {
  const window = state.mainWindow && !state.mainWindow.isDestroyed() ? state.mainWindow : undefined
  return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options)
}

/**
 * Quit Completely (app menu, tray): after confirmation the renderer runs Settings'
 * Kill all sessions, then asks main to quit. The renderer does the work because Kill all also
 * retires the tabs, so nothing reopens or resumes them on next launch.
 */
export function quitAndStopAllSessionsFromUserCommand(): void {
  // Why: under orca serve a user Quit only closes the windows (#15537), so this would never quit.
  if (state.isServeMode || quitAndStopAllSessionsConfirming) {
    return
  }
  quitAndStopAllSessionsConfirming = true
  // Why reveal first: the dialog is a sheet on this window, invisible while it is minimized or hidden.
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    showMainWindowFromTray()
  }
  // Why before asking: without a daemon provider (starting or failed) or with a newer version's daemon held,
  // Kill all can't list every session, so it would close every tab and then refuse.
  const ask: typeof confirmQuitAndStopAllSessions =
    getDaemonProvider() && !isHoldingForNewerProtocolDaemon()
      ? confirmQuitAndStopAllSessions
      : explainStopAllSessionsUnavailable
  void ask(showMessageBoxOnMainWindow)
    .then((confirmed) => {
      if (
        confirmed &&
        !sendOneShotToMainWindow(
          'ui:quitAndStopAllSessions',
          state.pendingQuitAndStopAllSessions,
          QUIT_AND_STOP_ALL_SESSIONS_REQUEST_TTL_MS
        )
      ) {
        console.warn('[quit] Quit Completely confirmed, but no main window could take the request')
      }
    })
    .catch((error) => console.error('[quit] Quit Completely failed:', error))
    .finally(() => {
      quitAndStopAllSessionsConfirming = false
    })
}

/** One-shot: true only for the renderer the confirmed request was sent to, before it expires. */
export function consumeQuitAndStopAllSessionsRequest(senderWebContentsId: number): boolean {
  const requested = state.pendingQuitAndStopAllSessions.matches(senderWebContentsId, {
    consume: true
  })
  if (requested) {
    stoppingAllSessionsWebContentsId = senderWebContentsId
  }
  return requested
}

/** The renderer that consumed the request stopped every session; quit unless the daemon still lists one. */
export async function quitAfterRendererStoppedAllSessions(
  senderWebContentsId: number
): Promise<boolean> {
  if (stoppingAllSessionsWebContentsId !== senderWebContentsId) {
    return false
  }
  stoppingAllSessionsWebContentsId = null
  if (!(await confirmNoDaemonSessionsRemain())) {
    console.warn('[quit] A terminal session is still listed after Kill all; staying open')
    return false
  }
  // Why reveal: the window may have been hidden while Kill all ran, and a quit-time save prompt must show.
  quitFromSystemTray()
  return true
}

export function runUserInitiatedUpdateCheck(options?: UpdateCheckOptions): void {
  ensureAutoUpdaterConfigured()
  checkForUpdatesFromMenu(options)
}

export function getSystemTrayOptions(): SystemTrayOptions | null {
  const store = state.store
  if (!store) {
    return null
  }
  return {
    appIcon: store.getSettings().appIcon,
    isDevInstance: state.devInstanceIdentity?.isDev ?? false,
    devInstanceLabel: state.devInstanceIdentity?.devLabel ?? null,
    onOpen: showMainWindowFromTray,
    onOpenSettings: openSettingsFromSystemMenu,
    onCheckForUpdates: () => {
      showMainWindowFromTray()
      runUserInitiatedUpdateCheck()
    },
    onQuit: quitFromSystemTray,
    ...(state.isServeMode
      ? {}
      : { onQuitAndStopAllSessions: quitAndStopAllSessionsFromUserCommand })
  }
}

export function getAppMenuQuitHandlers(): AppMenuQuitHandlers {
  return state.isServeMode
    ? { onQuit: quitFromUserCommand }
    : { onQuitAndStopAllSessions: quitAndStopAllSessionsFromUserCommand }
}

export function syncMacMenuBarIcon(showMenuBarIcon: boolean): Tray | null {
  if (process.platform !== 'darwin' || state.isServeMode) {
    return null
  }
  const options = getSystemTrayOptions()
  return options ? setMacMenuBarIconVisible(showMenuBarIcon, options) : null
}

export function createSystemTrayDeferred(
  window: BrowserWindow,
  onCreated?: () => void
): () => void {
  let trayCreated = false
  return () => {
    if (trayCreated || window.isDestroyed() || state.isQuitting || !state.store) {
      return
    }
    trayCreated = true
    if (process.platform === 'darwin') {
      if (syncMacMenuBarIcon(state.store.getSettings().showMenuBarIcon !== false)) {
        onCreated?.()
      }
      return
    }
    const options = getSystemTrayOptions()
    if (options && createSystemTray(options)) {
      onCreated?.()
    }
  }
}

function resolveMenuTargetRenderer(targetWindow?: BrowserWindow | null): WebContents | undefined {
  const invokingWindow = targetWindow && !targetWindow.isDestroyed() ? targetWindow : undefined
  const isCompanion =
    invokingWindow &&
    (invokingWindow === getDashboardPopoutWindow() || invokingWindow === getWorkspaceSpaceWindow())
  if (invokingWindow && !isCompanion && !isNativeBrowserPopupWindow(invokingWindow)) {
    return invokingWindow.webContents
  }
  const mainWindow = state.mainWindow
  if (!mainWindow || mainWindow.isDestroyed()) {
    return undefined
  }
  // Companion renderers do not mount the Help dialogs.
  if (isCompanion) {
    safelyRevealWindow(mainWindow)
  }
  return mainWindow.webContents
}

export function sendOpenFeatureTour(targetWindow?: BrowserWindow | null): void {
  resolveMenuTargetRenderer(targetWindow)?.send('ui:openFeatureTour')
}

export function sendOpenSetupGuide(targetWindow?: BrowserWindow | null): void {
  resolveMenuTargetRenderer(targetWindow)?.send('ui:openSetupGuide')
}

export function sendOpenCrashReport(targetWindow?: BrowserWindow | null): void {
  resolveMenuTargetRenderer(targetWindow)?.send('ui:openCrashReport')
}

// After automatic recovery stops, only main-process dialogs can offer retry/quit on a blank window.
export async function showRendererRecoveryPrompt(
  recentRecoveryCount: number,
  failure?: RendererRecoveryPromptFailure,
  retry?: () => void,
  availableCommitMB?: number
): Promise<void> {
  await presentRendererRecoveryPrompt({
    recentRecoveryCount,
    ...(failure ? { failure } : {}),
    ...(availableCommitMB === undefined ? {} : { availableCommitMB }),
    isQuitting: () => state.isQuitting,
    diagnose: describeInstallDirAclPoison,
    probeLaunchCapacity: () => probeRendererLaunchCapacity(),
    showMessageBox: showMessageBoxOnMainWindow,
    copyToClipboard: (text) => clipboard.writeText(text),
    reload: () => {
      if (!state.mainWindow || state.mainWindow.isDestroyed()) {
        return
      }
      recordDurableCrashBreadcrumb('renderer_recovery_manual_retry')
      // Keep the breaker open after manual retry; watchdog stalled retries so the default Reload cannot return users to a silent hang.
      if (retry) {
        retry()
        return
      }
      loadMainWindow(state.mainWindow)
    },
    quit: quitFromUserCommand
  })
}
