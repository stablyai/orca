import { screen, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'

/** Start the click-through poll for the pill overlay. The window stays
 *  click-through (setIgnoreMouseEvents true) everywhere except when the global
 *  cursor is inside the interactive content rect (window-origin + the rect the
 *  renderer reports), or while a pointer is pressed (a drag), in which case it
 *  captures. Returns a stop() that clears the interval. */
export function startClickThroughPoll(
  window: BrowserWindow,
  state: {
    getContentRect: () => {
      left: number
      top: number
      width: number
      height: number
    } | null
    isCapturing: () => boolean
    isExpanded: () => boolean
  }
): () => void {
  window.setIgnoreMouseEvents(true)
  const timer = setInterval(() => {
    if (window.isDestroyed()) {
      return
    }
    // Why: expanded island and an active press both force full capture so
    // panel clicks and drags never get dropped to the app behind.
    let overContent = state.isExpanded() || state.isCapturing()
    if (!overContent) {
      const rect = state.getContentRect()
      if (rect) {
        try {
          const cursor = screen.getCursorScreenPoint()
          const wb = window.getBounds()
          const x = wb.x + rect.left
          const y = wb.y + rect.top
          overContent =
            cursor.x >= x &&
            cursor.x <= x + rect.width &&
            cursor.y >= y &&
            cursor.y <= y + rect.height
        } catch {
          // Best-effort; screen API unavailable in tests.
        }
      }
    }
    try {
      window.setIgnoreMouseEvents(!overContent)
    } catch {
      // Best-effort.
    }
  }, 80)
  return () => clearInterval(timer)
}

/** Load the pill HTML entry. Dev uses electron-vite's URL; prod uses the
 *  packaged file with a single retry to absorb a fresh-build flush race. */
export async function loadPillEntry(
  window: BrowserWindow,
  warn: (m: string, e?: unknown) => void
): Promise<void> {
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/status-pill/`)
    return
  }
  try {
    await window.loadFile(join(__dirname, '../renderer/status-pill/index.html'))
  } catch (error) {
    warn('[status-pill] loadFile failed; retrying once after build flush', error)
    // Why: a freshly rebuilt dev package can race the renderer file flush.
    // Retry once after a short tick before giving up.
    await new Promise((resolve) => setTimeout(resolve, 250))
    await window.loadFile(join(__dirname, '../renderer/status-pill/index.html'))
  }
}

/** Subscribe to display changes so the pill re-anchors when monitors are
 *  added/removed or their metrics change. Returns a detach function. */
export function attachDisplayListeners(refresh: () => void): () => void {
  const onMetrics = (): void => refresh()
  const onAdded = (): void => refresh()
  const onRemoved = (): void => refresh()
  try {
    screen.on('display-metrics-changed', onMetrics)
    screen.on('display-added', onAdded)
    screen.on('display-removed', onRemoved)
  } catch {
    // Best-effort; headless/test environments may not emit these.
  }
  return () => {
    try {
      screen.off('display-metrics-changed', onMetrics)
      screen.off('display-added', onAdded)
      screen.off('display-removed', onRemoved)
    } catch {
      // Best-effort.
    }
  }
}

export function defaultStatusPillWarn(message: string, error?: unknown): void {
  // Why: keep the signature console-style so callers can substitute
  // `(m, e) => console.warn(m, e)` in tests without adapter gymnastics.
  if (error === undefined) {
    console.warn(message)
  } else {
    console.warn(message, error)
  }
}
