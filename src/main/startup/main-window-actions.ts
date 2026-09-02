import { app, clipboard, dialog, type BrowserWindow, type Tray } from 'electron'
import type { UpdateCheckOptions } from '../../shared/update-status-types'
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
import { loadMainWindow } from '../window/createMainWindow'
import { describeInstallDirAclPoison } from './windows-install-dir-acl-recovery'
import { presentRendererRecoveryPrompt } from '../window/renderer-recovery-prompt'

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

export function openSettingsFromSystemMenu(): void {
  showMainWindowFromTray()
  const targetWindow = state.mainWindow && !state.mainWindow.isDestroyed() ? state.mainWindow : null
  if (!targetWindow) {
    return
  }
  recordCrashBreadcrumb('settings_opened')
  targetWindow.webContents.send('ui:openSettings')
  state.pendingOpenSettings.mark(targetWindow.webContents.id, Number.POSITIVE_INFINITY)
}

export function quitFromSystemTray(): void {
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    showMainWindowFromTray()
  }
  state.isQuitting = true
  app.quit()
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
    onQuit: quitFromSystemTray
  }
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

export function sendOpenFeatureTour(targetWindow?: BrowserWindow | null): void {
  const webContents =
    targetWindow && !targetWindow.isDestroyed()
      ? targetWindow.webContents
      : state.mainWindow?.webContents
  webContents?.send('ui:openFeatureTour')
}

export function sendOpenSetupGuide(targetWindow?: BrowserWindow | null): void {
  const webContents =
    targetWindow && !targetWindow.isDestroyed()
      ? targetWindow.webContents
      : state.mainWindow?.webContents
  webContents?.send('ui:openSetupGuide')
}

export function sendOpenCrashReport(targetWindow?: BrowserWindow | null): void {
  const webContents =
    targetWindow && !targetWindow.isDestroyed()
      ? targetWindow.webContents
      : state.mainWindow?.webContents
  webContents?.send('ui:openCrashReport')
}

// Why: on renderer crash-loop the breaker stops auto-reloading and the window goes blank, so a main-process dialog is the only retry/quit surface.
export async function showRendererRecoveryPrompt(recentRecoveryCount: number): Promise<void> {
  await presentRendererRecoveryPrompt({
    recentRecoveryCount,
    isQuitting: () => state.isQuitting,
    diagnose: describeInstallDirAclPoison,
    showMessageBox: (options) => {
      const window =
        state.mainWindow && !state.mainWindow.isDestroyed() ? state.mainWindow : undefined
      return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options)
    },
    copyToClipboard: (text) => clipboard.writeText(text),
    reload: () => {
      if (!state.mainWindow || state.mainWindow.isDestroyed()) {
        return
      }
      recordDurableCrashBreadcrumb('renderer_recovery_manual_retry')
      // Why: leave the breaker open so a re-crash re-raises this prompt instead of resuming the auto-reload loop.
      loadMainWindow(state.mainWindow)
    },
    quit: () => {
      state.isQuitting = true
      app.quit()
    }
  })
}
