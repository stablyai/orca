import { app, BrowserWindow, nativeTheme, type WebContents } from 'electron'
import { join } from 'node:path'
import { isBackgroundLaunch, showWindowWithoutStealingFocus } from './foreground-activation-policy'
import { installPrivilegedWindowNavigationPolicy } from './privileged-window-navigation'
import { sendToTrustedUIRenderer } from '../ipc/ui'
import type { Store } from '../persistence'
import { stepUIZoomLevel, type UIZoomDirection } from '../../shared/ui-zoom-level'
import { wslHostsWindowArguments } from '../wsl/wsl-host-gate'

let spaceWindow: BrowserWindow | null = null

export function getWorkspaceSpaceWindow(): BrowserWindow | null {
  return spaceWindow && !spaceWindow.isDestroyed() && !spaceWindow.webContents.isDestroyed()
    ? spaceWindow
    : null
}

export function isWorkspaceSpaceWindowRenderer(sender: WebContents): boolean {
  return getWorkspaceSpaceWindow()?.webContents === sender
}

export function zoomWorkspaceSpaceWindowIfFocused(direction: UIZoomDirection): boolean {
  const window = getWorkspaceSpaceWindow()
  if (!window || !window.isFocused()) {
    return false
  }
  const contents = window.webContents
  contents.setZoomLevel(stepUIZoomLevel(contents.getZoomLevel(), direction))
  return true
}

export function createOrFocusWorkspaceSpaceWindow(store: Store): BrowserWindow {
  const existing = getWorkspaceSpaceWindow()
  if (existing) {
    if (existing.isMinimized()) {
      existing.restore()
    }
    if (!isBackgroundLaunch()) {
      existing.focus()
    }
    return existing
  }

  // Serve-only: this window lists saved WSL hosts and their Connect, as the main window does.
  const wslArguments = wslHostsWindowArguments()
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 700,
    minHeight: 520,
    title: 'Orca Space Beta',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      partition: 'orca-workspace-space-window',
      webviewTag: false,
      ...(wslArguments.length > 0 ? { additionalArguments: wslArguments } : {})
    }
  })
  spaceWindow = window
  installPrivilegedWindowNavigationPolicy(window.webContents)
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false)
  )
  window.webContents.session.setPermissionCheckHandler(() => false)
  window.webContents.on('dom-ready', () => {
    if (!window.isDestroyed()) {
      window.webContents.setZoomLevel(store.getUI().uiZoomLevel ?? 0)
    }
  })
  let lastFollowedZoomLevel = store.getUI().uiZoomLevel ?? 0
  const offUIChanged = store.onUIChanged((ui) => {
    const level = ui.uiZoomLevel ?? 0
    if (level !== lastFollowedZoomLevel && !window.isDestroyed()) {
      lastFollowedZoomLevel = level
      window.webContents.setZoomLevel(level)
    }
  })
  window.once('ready-to-show', () => showWindowWithoutStealingFocus(window))
  window.on('closed', () => {
    offUIChanged()
    if (spaceWindow === window) {
      spaceWindow = null
      sendToTrustedUIRenderer('workspaceSpace:windowClosed', null)
    }
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/space.html`)
  } else {
    void window.loadFile(join(__dirname, '../renderer/space.html'))
  }
  return window
}

export function closeWorkspaceSpaceWindow(): void {
  getWorkspaceSpaceWindow()?.close()
}
