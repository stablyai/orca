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

// The window module injects this callback to avoid a cycle between actions and lifecycle code.
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
    // Why: a 20s blank launch invites a second double-click, and the repair is rewriting
    // the per-file DACLs a fresh renderer would read. The gated launch opens the window.
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

/**
 * A user Quit (menu, tray, renderer-recovery prompt). Under `orca serve` the process is the
 * server its paired clients use, so a user Quit only closes the desktop windows (#15537);
 * signals, supervisor stops and update installs still quit through app.quit().
 */
export function quitFromUserCommand(): void {
  if (state.isServeMode) {
    // Why not getAllWindows(): offscreen browser-automation windows belong to the runtime.
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
 * Quit and Stop All Sessions (app menu, tray): after confirmation the renderer runs Settings'
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
      if (confirmed) {
        sendOneShotToMainWindow(
          'ui:quitAndStopAllSessions',
          state.pendingQuitAndStopAllSessions,
          QUIT_AND_STOP_ALL_SESSIONS_REQUEST_TTL_MS
        )
      }
    })
    .catch((error) => console.error('[quit] Quit and Stop All Sessions failed:', error))
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

/** The renderer that consumed the request stopped every session; finish with a user Quit. */
export function quitAfterRendererStoppedAllSessions(senderWebContentsId: number): void {
  if (stoppingAllSessionsWebContentsId !== senderWebContentsId) {
    return
  }
  stoppingAllSessionsWebContentsId = null
  // Why reveal: the window may have been hidden while Kill all ran, and a quit-time save prompt must show.
  quitFromSystemTray()
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
  // Why: a native browser popup is a BrowserWindow hosting a web page, not Orca's renderer.
  return targetWindow && !targetWindow.isDestroyed() && !isNativeBrowserPopupWindow(targetWindow)
    ? targetWindow.webContents
    : state.mainWindow?.webContents
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

// Why: once auto-recovery gives up the window stays blank, so a main-process dialog is the only retry/quit surface.
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
      // Why: leave the breaker open so a re-crash re-raises this prompt instead of resuming the auto-reload loop.
      // Why watched: Reload is the dialog's default button, and an unwatched retry that stalls returns the user to
      // the same silent hang with no further prompt — the watchdog re-raises this dialog instead.
      if (retry) {
        retry()
        return
      }
      loadMainWindow(state.mainWindow)
    },
    quit: quitFromUserCommand
  })
}
