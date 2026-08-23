import { BrowserWindow } from 'electron'
import { ORCA_BROWSER_GUEST_WEB_PREFERENCES } from '../../shared/browser-guest-web-preferences'

// Why: headless orca serve has no renderer window to host a <webview>, so each
// browser page is backed by a main-process offscreen BrowserWindow. The window
// is never shown — it exists only so its WebContents can be driven over CDP and
// streamed via the existing screencast path. Verified on macOS and on headless
// Linux under Xvfb (Electron --headless segfaults; a virtual display is
// required there — provisioned in the serve image, not by this code).

const DEFAULT_VIEWPORT_WIDTH = 1280
const DEFAULT_VIEWPORT_HEIGHT = 800
const LOAD_TIMEOUT_MS = 30_000
/**
 * How long a wake waits for the reloaded page before returning anyway. A wake
 * happens inside an RPC a paired client gives 15s (`browser.tabShow` in
 * remote-browser-page-session.ts), so waiting out the full load budget would
 * report the browser unreachable on any page slower than that. The page is
 * operable and still navigating when this elapses — the same contract a freshly
 * created tab has, since createTab never waits for its load either.
 */
export const OFFSCREEN_BROWSER_WAKE_LOAD_BUDGET_MS = 10_000

export function createOffscreenBrowserWindow(partition: string): BrowserWindow {
  return new BrowserWindow({
    show: false,
    width: DEFAULT_VIEWPORT_WIDTH,
    height: DEFAULT_VIEWPORT_HEIGHT,
    webPreferences: {
      // Why: offscreen pages are the SSH/headless browser backend; keep their
      // HTML fullscreen behavior aligned with desktop <webview> guests.
      ...ORCA_BROWSER_GUEST_WEB_PREFERENCES,
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
}

export async function loadOffscreenBrowserUrl(
  win: BrowserWindow,
  url: string,
  timeoutMs: number = LOAD_TIMEOUT_MS
): Promise<void> {
  const wc = win.webContents
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      // Why: about:blank and slow pages can resolve via timeout without a
      // did-finish-load; treat that as success so the tab is still operable.
      resolve()
    }, timeoutMs)

    const onFinish = (): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve()
    }
    const onFail = (
      _e: unknown,
      errorCode: number,
      errorDescription: string,
      _validatedURL: string,
      isMainFrame: boolean
    ): void => {
      // Why: subframe/iframe (e.g. ad/tracker) load failures also fire
      // did-fail-load. Only the main frame failing means the page itself
      // failed; ignore the rest or an otherwise-usable page gets rejected.
      if (!isMainFrame) {
        return
      }
      if (settled) {
        return
      }
      settled = true
      cleanup()
      // Why: aborted loads (-3) happen on redirects/SPA navigations and are not
      // real failures; the page is still usable.
      if (errorCode === -3) {
        resolve()
        return
      }
      reject(new Error(`${errorDescription} (${errorCode})`))
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      if (wc.isDestroyed()) {
        return
      }
      wc.removeListener('did-finish-load', onFinish)
      wc.removeListener('did-fail-load', onFail)
    }

    wc.on('did-finish-load', onFinish)
    wc.on('did-fail-load', onFail)
    void wc.loadURL(url).catch(() => {
      // loadURL rejects on aborted navigations; did-fail-load handles the rest.
    })
  })
}
