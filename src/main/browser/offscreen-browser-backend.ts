import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import { ORCA_BROWSER_PARTITION } from '../../shared/constants'
import { ORCA_BROWSER_GUEST_WEB_PREFERENCES } from '../../shared/browser-guest-web-preferences'
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
  private readonly pendingCloseById = new Map<string, Promise<void>>()
  private readonly reportedClosedPageIds = new Set<string>()

  constructor(
    private readonly browserManager: BrowserManager,
    private readonly onWebContentsClosed?: (webContentsId: number) => Promise<void>
  ) {}

  async createTab(params: BrowserBackendCreateTab): Promise<{ browserPageId: string }> {
    const browserPageId = params.browserPageId ?? randomUUID()
    await this.pendingCloseById.get(browserPageId)?.catch(() => {})
    if (this.windowsByPageId.has(browserPageId)) {
      throw new Error(`Browser page ${browserPageId} already exists`)
    }
    this.reportedClosedPageIds.delete(browserPageId)
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
        // Why: offscreen pages are the SSH/headless browser backend; keep their
        // HTML fullscreen behavior aligned with desktop <webview> guests.
        ...ORCA_BROWSER_GUEST_WEB_PREFERENCES,
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })

    this.windowsByPageId.set(browserPageId, win)
    const webContentsId = win.webContents.id

    // Why: if the offscreen window is destroyed out from under us (crash, app
    // teardown), drop the registry entry so commands fail cleanly instead of
    // resolving a dead WebContents.
    win.webContents.once('destroyed', () => {
      // A delayed event from an old window must not remove a replacement page.
      if (this.windowsByPageId.get(browserPageId) !== win) {
        return
      }
      this.windowsByPageId.delete(browserPageId)
      if (!this.pendingCloseById.has(browserPageId)) {
        this.trackPendingClose(browserPageId, this.reportClosed(browserPageId, webContentsId))
      }
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
      userAgentMode: profile?.userAgentMode,
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
    if (!win) {
      await this.pendingCloseById.get(browserPageId)
      return
    }
    this.windowsByPageId.delete(browserPageId)
    const cleanup = this.reportClosed(browserPageId, win.webContents.id)
    this.trackPendingClose(browserPageId, cleanup)
    if (win && !win.isDestroyed()) {
      win.destroy()
    }
    await cleanup
  }

  getWebContentsId(browserPageId: string): number | null {
    const win = this.windowsByPageId.get(browserPageId)
    return win && !win.isDestroyed() ? win.webContents.id : null
  }

  destroyAll(): void {
    for (const [pageId, win] of this.windowsByPageId) {
      this.trackPendingClose(pageId, this.reportClosed(pageId, win.webContents.id))
      if (!win.isDestroyed()) {
        win.destroy()
      }
    }
    this.windowsByPageId.clear()
  }

  private async reportClosed(browserPageId: string, webContentsId: number): Promise<void> {
    if (this.reportedClosedPageIds.has(browserPageId)) {
      return
    }
    this.reportedClosedPageIds.add(browserPageId)
    try {
      await this.onWebContentsClosed?.(webContentsId)
    } catch (error) {
      console.warn(
        '[offscreen-browser] tab cleanup failed:',
        error instanceof Error ? error.message : String(error)
      )
    } finally {
      // Keep the BrowserManager identity until the bridge has released its page/session state.
      this.browserManager.unregisterGuest(browserPageId)
    }
  }

  private trackPendingClose(browserPageId: string, cleanup: Promise<void>): void {
    this.pendingCloseById.set(browserPageId, cleanup)
    void cleanup
      .finally(() => {
        if (this.pendingCloseById.get(browserPageId) === cleanup) {
          this.pendingCloseById.delete(browserPageId)
        }
        this.reportedClosedPageIds.delete(browserPageId)
      })
      .catch(() => {})
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
      const onDestroyed = (): void => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        resolve()
      }
      const cleanup = (): void => {
        clearTimeout(timer)
        wc.removeListener('did-finish-load', onFinish)
        wc.removeListener('did-fail-load', onFail)
        wc.removeListener('destroyed', onDestroyed)
      }

      wc.on('did-finish-load', onFinish)
      wc.on('did-fail-load', onFail)
      wc.on('destroyed', onDestroyed)
      void wc.loadURL(url).catch(() => {
        // loadURL rejects on aborted navigations; did-fail-load handles the rest.
      })
    })
  }
}
