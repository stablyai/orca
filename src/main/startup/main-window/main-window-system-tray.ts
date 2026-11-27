import type { BrowserWindow, Tray } from 'electron'
import {
  createSystemTray,
  setMacMenuBarIconVisible,
  type SystemTrayOptions
} from '../../tray/system-tray'
import { macWindowsHiddenToMenuBar } from '../../window/main-window/macos-menu-bar-hidden-window'
import { mainProcessState as state } from '../main-process-state'
import {
  openSettingsFromSystemMenu,
  quitAndStopAllSessionsFromUserCommand,
  quitFromSystemTray,
  runUserInitiatedUpdateCheck,
  showMainWindowFromTray
} from './main-window-actions'

function getSystemTrayOptions(): SystemTrayOptions | null {
  const store = state.store
  if (!store) {
    return null
  }
  return {
    appIcon: store.getSettings().appIcon,
    isDevInstance: state.devInstanceIdentity?.isDev ?? false,
    devInstanceLabel: state.devInstanceIdentity?.devLabel ?? null,
    onOpen: showMainWindowFromTray,
    ...(store.getSettings().macWindowCloseBehavior === 'hide-to-menu-bar' && {
      shouldRestoreOnClick: () =>
        state.mainWindow !== null && macWindowsHiddenToMenuBar.has(state.mainWindow)
    }),
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

export function syncMacMenuBarIcon(): Tray | null {
  if (process.platform !== 'darwin' || state.isServeMode || state.isQuitting) {
    return null
  }
  const options = getSystemTrayOptions()
  return options
    ? setMacMenuBarIconVisible(
        state.store?.getSettings().showMenuBarIcon !== false ||
          Boolean(options.shouldRestoreOnClick),
        options
      )
    : null
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
      if (syncMacMenuBarIcon()) {
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
