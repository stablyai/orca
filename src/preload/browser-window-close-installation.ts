/** Why written out: the sandboxed preload can't load shared chunks; the test pins it to the shared constant. */
export const PRELOAD_BROWSER_GUEST_WINDOW_CLOSE_CHANNEL = 'orca:guest-window-close'

/**
 * Runs serialized in the page's main world. The native close stays blocked: it destroyed the
 * guest under a live <webview> (#11763, #12040). Orca decides whether to close the tab instead.
 */
export function installBrowserWindowCloseGuard(requestClose: () => void): void {
  const close = (): void => {
    requestClose()
  }
  try {
    Object.defineProperty(window, 'close', {
      configurable: false,
      enumerable: false,
      writable: false,
      value: close
    })
  } catch {
    try {
      window.close = close
    } catch {}
  }
}
