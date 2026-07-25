import { BrowserWindow, ipcMain } from 'electron'

/**
 * Resets a window's stale CSS hover state after Chromium leaks guest coordinates out of a `<webview>`.
 *
 * Why here and not in the renderer: releasing the mouse inside a browser/mobile pane delivers the
 * embedder a `pointerup` carrying the guest's *viewport* coordinates (screen coordinates stay correct),
 * so Blink hit-tests a point one webview-origin away from the real cursor and parks `:hover` on whatever
 * sidebar row sits there. Only trusted input moves Blink's hover state, and renderers cannot synthesize
 * it — `pointer-events: none` and untrusted events both leave the stale hover in place. A `mouseLeave`
 * is the honest correction: the real pointer is inside the guest, so nothing in the host is hovered.
 */
export const CLEAR_STALE_HOVER_CHANNEL = 'ui:clearStaleHoverState'

/** Why: one leak per mouse release, but coalesce bursts so a wedged renderer cannot flood input. */
const MIN_RESET_INTERVAL_MS = 50

const lastResetByWebContentsId = new Map<number, number>()

export function registerWebviewHoverLeakHandlers(now: () => number = Date.now): void {
  ipcMain.removeHandler(CLEAR_STALE_HOVER_CHANNEL)
  ipcMain.handle(CLEAR_STALE_HOVER_CHANNEL, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || window.isDestroyed()) {
      return
    }
    const senderId = event.sender.id
    const at = now()
    const last = lastResetByWebContentsId.get(senderId)
    if (last !== undefined && at - last < MIN_RESET_INTERVAL_MS) {
      return
    }
    lastResetByWebContentsId.set(senderId, at)
    // Why: coordinates are fixed here rather than taken from the renderer — the only capability this
    // exposes is "forget the hover in your own window", never a synthetic click at a chosen point.
    window.webContents.sendInputEvent({ type: 'mouseLeave', x: -1, y: -1 })
  })
}

/** Test seam: drop coalescing state between cases. */
export function resetWebviewHoverLeakThrottleForTests(): void {
  lastResetByWebContentsId.clear()
}
