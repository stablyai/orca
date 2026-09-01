import { ipcMain, type BrowserWindow } from 'electron'
import { isMacosTahoeOrNewer } from './macos-tahoe-release'

const activeRepaintJiggles = new WeakSet<BrowserWindow>()
export function forceRepaint(window: BrowserWindow): void {
  // Why: webContents can be destroyed a beat before the BrowserWindow during close, and this runs from timers/focus events in that gap.
  if (window.isDestroyed() || window.webContents.isDestroyed()) {
    return
  }
  window.webContents.invalidate()
  // Why: macOS 26 scene-backed windows deadlock on frame mutation, and device emulation can
  // strand the compositor after wake. The native shell no longer relies on dvh reflow.
  if (isMacosTahoeOrNewer()) {
    return
  }
  if (window.isMaximized() || window.isFullScreen() || activeRepaintJiggles.has(window)) {
    return
  }
  activeRepaintJiggles.add(window)
  // Why: show/restore fire from inside AppKit's window-state dispatch; mutating the frame there re-enters scene handling, so nudge on a fresh turn.
  setTimeout(() => {
    if (window.isDestroyed()) {
      activeRepaintJiggles.delete(window)
      return
    }
    const [width, height] = window.getSize()
    // Why: if the nudge throws mid-flight the WeakSet entry must still clear, or this window
    // never repaints again.
    try {
      window.setSize(width + 1, height)
    } catch {
      activeRepaintJiggles.delete(window)
      return
    }
    setTimeout(() => {
      try {
        if (!window.isDestroyed()) {
          const [currentWidth, currentHeight] = window.getSize()
          // Why: a real user resize during the jiggle owns the final bounds.
          if (currentWidth === width + 1 && currentHeight === height) {
            window.setSize(width, height)
          }
        }
      } finally {
        activeRepaintJiggles.delete(window)
      }
    }, 32)
  }, 0)
}

export function installMacosVisibilityRepaint(window: BrowserWindow): void {
  let delayedRepaintTimer: ReturnType<typeof setTimeout> | null = null
  const repaintAfterVisibilityTransition = (): void => {
    forceRepaint(window)
    if (delayedRepaintTimer) {
      clearTimeout(delayedRepaintTimer)
    }
    // Why: macOS may restore compositor layers after the show/restore event; a second paint catches late black-surface recovery.
    delayedRepaintTimer = setTimeout(() => {
      delayedRepaintTimer = null
      forceRepaint(window)
    }, 250)
  }
  const clearDelayedRepaint = (): void => {
    if (delayedRepaintTimer) {
      clearTimeout(delayedRepaintTimer)
      delayedRepaintTimer = null
    }
  }

  // Why: occlusion reveal can fire no restore/show, so preserve the renderer relay without
  // trusting events from another window.
  const onRendererRevealed = (event: Electron.IpcMainEvent): void => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) {
      return
    }
    if (event.sender !== window.webContents) {
      return
    }
    forceRepaint(window)
  }
  ipcMain.on('ui:window-revealed', onRendererRevealed)

  window.on('restore', repaintAfterVisibilityTransition)
  window.on('show', repaintAfterVisibilityTransition)
  // Why: occlusion-uncover can fire only focus; invalidate without resizing terminals on Cmd+Tab.
  window.on('focus', () => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.invalidate()
    }
  })
  window.on('closed', () => {
    clearDelayedRepaint()
    ipcMain.removeListener('ui:window-revealed', onRendererRevealed)
  })
}

export function isMacAppPasteInput(input: Electron.Input): boolean {
  return (
    process.platform === 'darwin' &&
    input.type === 'keyDown' &&
    input.meta &&
    !input.control &&
    !input.alt &&
    !input.shift &&
    (input.code === 'KeyV' || input.key.toLowerCase() === 'v')
  )
}

// Why: titlebar content center sits ~18 CSS px from top (×zoom); traffic lights are ~12px tall, so top edge = center − 6.
export const TITLEBAR_CSS_CENTER = 18
export const TRAFFIC_LIGHT_RADIUS = 6
export const TRAFFIC_LIGHT_X = 16
export const MIN_WIDTH = 600
export const MIN_HEIGHT = 400

export function syncTrafficLightPosition(win: BrowserWindow, zoomFactor: number): void {
  if (process.platform !== 'darwin' || win.isDestroyed()) {
    return
  }
  const y = Math.round(TITLEBAR_CSS_CENTER * zoomFactor - TRAFFIC_LIGHT_RADIUS)
  win.setWindowButtonPosition({ x: TRAFFIC_LIGHT_X, y })
}
