import { app, BrowserWindow, nativeTheme } from 'electron'
import { join } from 'node:path'
import { sendToTrustedUIRenderer } from '../ipc/ui'
import { isBackgroundLaunch, showWindowWithoutStealingFocus } from './foreground-activation-policy'
import { installPrivilegedWindowNavigationPolicy } from './privileged-window-navigation'

export type DetachedTerminalWindowArgs = {
  tabId: string
  ptyId: string
  title: string
}

type DetachedTerminalEntry = {
  window: BrowserWindow
  ptyId: string
}

const entriesByTabId = new Map<string, DetachedTerminalEntry>()

function loadDetachedTerminalWindow(window: BrowserWindow, args: DetachedTerminalWindowArgs): void {
  const query = { surface: 'terminal', ...args }
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    const params = new URLSearchParams(query)
    void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/popout.html?${params.toString()}`)
    return
  }
  void window.loadFile(join(__dirname, '../renderer/popout.html'), { query })
}

export function isDetachedTerminalRenderer(sender: unknown): boolean {
  for (const entry of entriesByTabId.values()) {
    if (!entry.window.isDestroyed() && entry.window.webContents === sender) {
      return true
    }
  }
  return false
}

export function isDetachedTerminalRendererForTab(sender: unknown, tabId: string): boolean {
  const entry = entriesByTabId.get(tabId)
  return Boolean(entry && !entry.window.isDestroyed() && entry.window.webContents === sender)
}

export function isDetachedTerminalRendererForPty(sender: unknown, ptyId: string): boolean {
  for (const entry of entriesByTabId.values()) {
    if (
      !entry.window.isDestroyed() &&
      entry.window.webContents === sender &&
      entry.ptyId === ptyId
    ) {
      return true
    }
  }
  return false
}

export function createOrFocusDetachedTerminalWindow(
  args: DetachedTerminalWindowArgs
): BrowserWindow {
  const existing = entriesByTabId.get(args.tabId)
  if (existing && !existing.window.isDestroyed()) {
    if (existing.window.isMinimized()) {
      existing.window.restore()
    }
    if (!isBackgroundLaunch()) {
      existing.window.focus()
    }
    return existing.window
  }

  const window = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 480,
    minHeight: 360,
    title: args.title,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      partition: 'orca-detached-terminal',
      webviewTag: false
    }
  })
  installPrivilegedWindowNavigationPolicy(window.webContents)
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false)
  )
  window.webContents.session.setPermissionCheckHandler(() => false)
  entriesByTabId.set(args.tabId, { window, ptyId: args.ptyId })

  window.once('ready-to-show', () => showWindowWithoutStealingFocus(window))
  // Why: re-dock the terminal tab back into the main window when the companion renderer dies.
  window.webContents.on('render-process-gone', () => {
    if (!window.isDestroyed()) {
      window.close()
    }
  })
  // Why: the closed event is the single source of truth for teardown; re-dock in the main renderer is idempotent.
  window.on('closed', () => {
    if (entriesByTabId.get(args.tabId)?.window !== window) {
      return
    }
    entriesByTabId.delete(args.tabId)
    sendToTrustedUIRenderer('detachedTerminal:closed', { tabId: args.tabId })
  })

  loadDetachedTerminalWindow(window, args)
  return window
}

export function closeDetachedTerminalWindow(tabId: string): void {
  const entry = entriesByTabId.get(tabId)
  if (entry && !entry.window.isDestroyed()) {
    entry.window.close()
  }
}

export function closeAllDetachedTerminalWindows(): void {
  for (const entry of entriesByTabId.values()) {
    if (!entry.window.isDestroyed()) {
      entry.window.close()
    }
  }
}
