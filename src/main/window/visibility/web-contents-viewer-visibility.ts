import { BrowserWindow, type WebContents } from 'electron'
import type { StructuredAgentSessionViewerVisibility } from '../../../shared/agent-session/view/live-read/structured-agent-session-coalescer'
import { isMainWindowVisible } from './main-window-visibility'

// One show/restore listener pair per window, however many streams it has open.
const shownListeners = new WeakMap<BrowserWindow, Set<() => void>>()

function watchShown(window: BrowserWindow, shown: () => void): () => void {
  let listeners = shownListeners.get(window)
  if (!listeners) {
    const fanOut = new Set<() => void>()
    const notify = (): void => fanOut.forEach((listener) => listener())
    window.on('show', notify)
    window.on('restore', notify)
    shownListeners.set(window, fanOut)
    listeners = fanOut
  }
  listeners.add(shown)
  return () => listeners.delete(shown)
}

/** A renderer's window as a stream's viewer: while it is minimized or hidden, its streams skip
 *  live work, and catch up when it shows. */
export function webContentsViewerVisibility(
  sender: WebContents
): StructuredAgentSessionViewerVisibility | undefined {
  const window = BrowserWindow.fromWebContents(sender)
  if (!window) {
    return undefined
  }
  return {
    hidden: () => !window.isDestroyed() && !isMainWindowVisible(window),
    subscribeShown: (shown) => (window.isDestroyed() ? () => {} : watchShown(window, shown))
  }
}
