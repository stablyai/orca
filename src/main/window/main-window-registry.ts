import { BrowserWindow } from 'electron'
import type { WebContents } from 'electron'

const windowsById = new Map<number, BrowserWindow>()
let lastActiveWindowId: number | null = null

function isLiveWindow(window: BrowserWindow | null | undefined): window is BrowserWindow {
  return Boolean(window && !window.isDestroyed())
}

function pruneDeadWindow(id: number, window: BrowserWindow): boolean {
  if (isLiveWindow(window)) {
    return false
  }
  windowsById.delete(id)
  if (lastActiveWindowId === id) {
    lastActiveWindowId = null
  }
  return true
}

function rememberLastActive(window: BrowserWindow): void {
  if (isLiveWindow(window) && windowsById.get(window.id) === window) {
    lastActiveWindowId = window.id
  }
}

function forgetWindow(window: BrowserWindow): void {
  if (windowsById.get(window.id) === window) {
    windowsById.delete(window.id)
  }
  if (lastActiveWindowId === window.id) {
    lastActiveWindowId = getMainWindows().at(-1)?.id ?? null
  }
}

export function registerMainWindow(window: BrowserWindow): void {
  windowsById.set(window.id, window)
  rememberLastActive(window)
  const onFocus = (): void => rememberLastActive(window)
  const onClosed = (): void => {
    window.removeListener('focus', onFocus)
    forgetWindow(window)
  }
  window.on('focus', onFocus)
  window.once('closed', onClosed)
}

export function getMainWindows(): BrowserWindow[] {
  const liveWindows: BrowserWindow[] = []
  for (const [id, window] of windowsById) {
    if (!pruneDeadWindow(id, window)) {
      liveWindows.push(window)
    }
  }
  return liveWindows
}

export function getSingleMainWindow(): BrowserWindow | null {
  let singleWindow: BrowserWindow | null = null
  for (const [id, window] of windowsById) {
    if (pruneDeadWindow(id, window)) {
      continue
    }
    if (singleWindow) {
      return null
    }
    singleWindow = window
  }
  return singleWindow
}

export function getLastActiveMainWindow(): BrowserWindow | null {
  const lastActive = lastActiveWindowId === null ? null : windowsById.get(lastActiveWindowId)
  if (isLiveWindow(lastActive)) {
    return lastActive
  }
  lastActiveWindowId = null
  return getMainWindows().at(-1) ?? null
}

export function getFocusedOrLastActiveMainWindow(): BrowserWindow | null {
  const focusedWindow = BrowserWindow.getFocusedWindow()
  if (isLiveWindow(focusedWindow) && windowsById.get(focusedWindow.id) === focusedWindow) {
    return focusedWindow
  }
  return getLastActiveMainWindow()
}

export function getMainWindowById(windowId: number): BrowserWindow | null {
  const window = windowsById.get(windowId)
  if (isLiveWindow(window)) {
    return window
  }
  windowsById.delete(windowId)
  if (lastActiveWindowId === windowId) {
    lastActiveWindowId = null
  }
  return null
}

export function getMainWindowForWebContents(webContents: WebContents): BrowserWindow | null {
  const window = BrowserWindow.fromWebContents(webContents)
  if (!isLiveWindow(window)) {
    return null
  }
  return windowsById.get(window.id) === window ? window : null
}

export function getRegisteredMainWindow(
  window: Electron.BaseWindow | null | undefined
): BrowserWindow | null {
  if (!(window instanceof BrowserWindow) || !isLiveWindow(window)) {
    return null
  }
  return windowsById.get(window.id) === window ? window : null
}

export function focusOrOpenMainWindow(openWindow: () => BrowserWindow): BrowserWindow {
  const window = getFocusedOrLastActiveMainWindow()
  if (window) {
    if (window.isMinimized()) {
      window.restore()
    }
    window.show()
    window.focus()
    return window
  }
  return openWindow()
}

export function sendToWindow(window: BrowserWindow, channel: string, ...args: unknown[]): void {
  if (window.isDestroyed()) {
    return
  }
  const webContents = window.webContents
  const webContentsDestroyed =
    typeof webContents.isDestroyed === 'function' && webContents.isDestroyed()
  if (webContentsDestroyed) {
    return
  }
  webContents.send(channel, ...args)
}

export function broadcastToMainWindows(channel: string, ...args: unknown[]): void {
  // Why: PTY title frames and agent status updates can be frequent. Iterate the
  // registry directly instead of allocating a fresh windows array per broadcast.
  for (const [id, window] of windowsById) {
    if (pruneDeadWindow(id, window)) {
      continue
    }
    sendToWindow(window, channel, ...args)
  }
}

export function hasLiveMainWindows(): boolean {
  for (const [id, window] of windowsById) {
    if (pruneDeadWindow(id, window)) {
      continue
    }
    return true
  }
  return false
}

export function hasVisibleMainWindow(): boolean {
  for (const [id, window] of windowsById) {
    if (pruneDeadWindow(id, window)) {
      continue
    }
    if (window.isVisible() && !window.isMinimized()) {
      return true
    }
  }
  return false
}
