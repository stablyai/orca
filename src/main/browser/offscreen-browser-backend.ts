import { randomUUID } from 'crypto'
import { BrowserWindow } from 'electron'
import { ORCA_BROWSER_PARTITION } from '../../shared/constants'
import type { BrowserBackend, BrowserBackendCreateTab } from './browser-backend'
import type { BrowserManager } from './browser-manager'
import { browserSessionRegistry } from './browser-session-registry'

// Why: headless orca serve has no renderer window to host a <webview>, so each
// browser page is backed by a main-process offscreen BrowserWindow. The window
// is never shown — it exists only so its WebContents can be driven over CDP and
// streamed via the existing screencast path. Verified on macOS and on headless
// Linux under Xvfb (Electron --headless segfaults; a virtual display is
// required there — provisioned in the serve image, not by this code).

const DEFAULT_VIEWPORT_WIDTH = 1280
const DEFAULT_VIEWPORT_HEIGHT = 800
const LOAD_TIMEOUT_MS = 30_000

export class OffscreenBrowserBackend implements BrowserBackend {
  private readonly windowsByPageId = new Map<string, BrowserWindow>()

  constructor(private readonly browserManager: BrowserManager) {}

  async createTab(params: BrowserBackendCreateTab): Promise<{ browserPageId: string }> {
    const browserPageId = randomUUID()
    // Why: profiles map to Electron partitions; using the profile's partition
    // makes cookies/storage persist in the same SQLite DB the desktop path uses.
    const profile = params.profileId
      ? browserSessionRegistry.getProfile(params.profileId)
      : browserSessionRegistry.getDefaultProfile()
    const partition = profile?.partition ?? ORCA_BROWSER_PARTITION

    const win = new BrowserWindow({
      show: false,
      width: DEFAULT_VIEWPORT_WIDTH,
      height: DEFAULT_VIEWPORT_HEIGHT,
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })

    this.windowsByPageId.set(browserPageId, win)

    // Why: if the offscreen window is destroyed out from under us (crash, app
    // teardown), drop the registry entry so commands fail cleanly instead of
    // resolving a dead WebContents.
    win.webContents.once('destroyed', () => {
      this.windowsByPageId.delete(browserPageId)
      this.browserManager.unregisterGuest(browserPageId)
    })

    // Why: register the guest and return immediately so the new tab appears
    // without waiting for the page to finish loading. Previously createTab
    // awaited the full navigation, so clicking "New Browser Tab" did nothing for
    // up to a second on real URLs. The page loads asynchronously and streams
    // once it paints; a failed load leaves the (usable) tab open, matching how a
    // normal browser tab survives a failed navigation.
    this.browserManager.registerOffscreenGuest({
      browserPageId,
      worktreeId: params.worktreeId,
      sessionProfileId: profile?.id ?? null,
      webContentsId: win.webContents.id
    })

    const url = params.url || 'about:blank'
    void this.loadUrl(win, url).catch((error) => {
      console.warn(
        '[offscreen-browser] page load failed:',
        error instanceof Error ? error.message : String(error)
      )
    })

    return { browserPageId }
  }

  async closeTab(browserPageId: string): Promise<void> {
    const win = this.windowsByPageId.get(browserPageId)
    this.windowsByPageId.delete(browserPageId)
    this.browserManager.unregisterGuest(browserPageId)
    if (win && !win.isDestroyed()) {
      win.destroy()
    }
  }

  getWebContentsId(browserPageId: string): number | null {
    const win = this.windowsByPageId.get(browserPageId)
    return win && !win.isDestroyed() ? win.webContents.id : null
  }

  destroyAll(): void {
    for (const [pageId, win] of this.windowsByPageId) {
      this.browserManager.unregisterGuest(pageId)
      if (!win.isDestroyed()) {
        win.destroy()
      }
    }
    this.windowsByPageId.clear()
  }

  private async loadUrl(win: BrowserWindow, url: string): Promise<void> {
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
      }, LOAD_TIMEOUT_MS)

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
}
