import { BROWSER_GUEST_WINDOW_CLOSE_CHANNEL } from '../shared/browser-guest-window-close'

// Why: serialized into the page world, so it may only use its argument. The native close
// destroys the guest under the embedder, so the page can only ask Orca to close its tab.
export function installBrowserWindowCloseGuard(requestClose: () => void): void {
  const closeWindow = (): void => {
    requestClose()
  }
  try {
    Object.defineProperty(window, 'close', {
      configurable: false,
      enumerable: false,
      writable: false,
      value: closeWindow
    })
  } catch {
    try {
      window.close = closeWindow
    } catch {}
  }
}

// Why: Chromium lets a page close a tab no script opened only while it holds one history entry.
export function createBrowserWindowCloseRequest(sendToHost: (channel: string) => void): () => void {
  return () => {
    if (window.history.length <= 1) {
      sendToHost(BROWSER_GUEST_WINDOW_CLOSE_CHANNEL)
    }
  }
}
