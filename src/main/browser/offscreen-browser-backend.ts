import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import { ORCA_BROWSER_PARTITION } from '../../shared/constants'
import { ORCA_BROWSER_GUEST_WEB_PREFERENCES } from '../../shared/browser-guest-web-preferences'
import { mapSettledWithConcurrency } from '../../shared/map-with-concurrency'
import type { BrowserBackend, BrowserBackendCreateTab } from './browser-backend'
import type { BrowserManager } from './browser-manager'
import type { AgentBrowserBridge } from './agent-browser-bridge'
import { browserSessionRegistry } from './browser-session-registry'
import { installBrowserJavaScriptDialogs } from './browser-javascript-dialogs'
import type { ServeBrowserPageState } from '../runtime/serve-browser-tab-layout'

// orca serve has no renderer for webviews; hidden BrowserWindows host its pages.
// Headless Linux requires Xvfb; Electron --headless segfaults.

const DEFAULT_VIEWPORT_WIDTH = 1280
const DEFAULT_VIEWPORT_HEIGHT = 800
const LOAD_TIMEOUT_MS = 30_000
const OWNER_RETIREMENT_CONCURRENCY = 4

export class OffscreenBrowserBackend implements BrowserBackend {
  private readonly windowsByPageId = new Map<string, BrowserWindow>()
  // Reject creates once shutdown starts so pages cannot escape destroyAll's ownership snapshot.
  private shutdownStarted = false
  private readonly pendingOwnerRetirements = new Set<Promise<void>>()

  constructor(
    private readonly browserManager: BrowserManager,
    private readonly options: {
      getAgentBrowserBridge?: () => Pick<AgentBrowserBridge, 'onPageClosed'> | null
      onPageNavigated?: (page: ServeBrowserPageState) => void
    } = {}
  ) {}

  async createTab(params: BrowserBackendCreateTab): Promise<{ browserPageId: string }> {
    if (this.shutdownStarted) {
      throw new Error('Offscreen browser backend is shutting down')
    }
    const browserPageId = params.browserPageId ?? randomUUID()
    if (this.windowsByPageId.has(browserPageId)) {
      throw new Error(`Browser page ${browserPageId} already exists`)
    }
    // Reuse desktop profile partitions to preserve cookies and storage.
    const profile = params.profileId
      ? browserSessionRegistry.getProfile(params.profileId)
      : browserSessionRegistry.getDefaultProfile()
    const partition = profile?.partition ?? ORCA_BROWSER_PARTITION

    const win = new BrowserWindow({
      show: false,
      width: DEFAULT_VIEWPORT_WIDTH,
      height: DEFAULT_VIEWPORT_HEIGHT,
      webPreferences: {
        ...ORCA_BROWSER_GUEST_WEB_PREFERENCES,
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })

    this.windowsByPageId.set(browserPageId, win)
    // Server pages have no window to ask in; agents and phones answer their dialogs.
    installBrowserJavaScriptDialogs(win.webContents, () => null)

    // Do not wait for navigation: slow or failed loads must leave an operable tab.
    const registered = this.browserManager.registerOffscreenGuest({
      browserPageId,
      worktreeId: params.worktreeId,
      sessionProfileId: profile?.id ?? null,
      webContentsId: win.webContents.id
    })
    if (!registered) {
      // Registration installs guest policies; destroy refused windows before any navigation.
      this.windowsByPageId.delete(browserPageId)
      win.destroy()
      throw new Error(`Browser page ${browserPageId} was refused`)
    }

    // Install teardown only after registration; a refused id may belong to a document preview.
    win.webContents.once('destroyed', () => {
      // Explicit close already removed ownership and awaits bridge retirement.
      if (this.windowsByPageId.get(browserPageId) !== win) {
        return
      }
      void this.retirePageOwner(browserPageId)
      this.windowsByPageId.delete(browserPageId)
      this.browserManager.unregisterGuest(browserPageId)
    })

    const { worktreeId } = params
    const { onPageNavigated } = this.options
    if (worktreeId && onPageNavigated) {
      const report = (): void =>
        onPageNavigated({
          worktreeId,
          pageId: browserPageId,
          url: win.webContents.getURL(),
          title: win.webContents.getTitle()
        })
      // Persist at navigation milestones, avoiding writes for every dynamic title update.
      win.webContents.on('did-navigate-in-page', report)
      win.webContents.on('did-stop-loading', report)
    }

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
    try {
      if (win) {
        await this.retirePageOwner(browserPageId)
      }
    } finally {
      if (win && !win.isDestroyed()) {
        endDebuggerSessions(win)
        win.destroy()
      }
    }
  }

  ownsTab(browserPageId: string): boolean {
    return this.windowsByPageId.has(browserPageId)
  }

  getWebContentsId(browserPageId: string): number | null {
    const win = this.windowsByPageId.get(browserPageId)
    return win && !win.isDestroyed() ? win.webContents.id : null
  }

  async destroyAll(): Promise<void> {
    this.shutdownStarted = true
    const pageIds = [...this.windowsByPageId.keys()]
    await mapSettledWithConcurrency(pageIds, OWNER_RETIREMENT_CONCURRENCY, (pageId) =>
      this.closeTab(pageId)
    )
    await Promise.all(this.pendingOwnerRetirements)
  }

  private retirePageOwner(browserPageId: string): Promise<void> {
    const bridge = this.options.getAgentBrowserBridge?.()
    if (!bridge) {
      return Promise.resolve()
    }
    const retirement = bridge.onPageClosed(browserPageId).catch(() => {})
    this.pendingOwnerRetirements.add(retirement)
    void retirement.finally(() => this.pendingOwnerRetirements.delete(retirement))
    return retirement
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
        // Missing did-finish-load must not make a slow or about:blank tab unusable.
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
        // Subframe load failures do not make the whole page unusable.
        if (!isMainFrame) {
          return
        }
        if (settled) {
          return
        }
        settled = true
        cleanup()
        // Redirects and SPA navigations can abort loads with ERR_ABORTED (-3).
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
      wc.once('destroyed', onDestroyed)
      void wc.loadURL(url).catch(() => {
        // loadURL rejects on aborted navigations; did-fail-load handles the rest.
      })
    })
  }
}

// Detach before destroy: rejected CDP snapshots can call capturePage during teardown and crash Electron 43.7.8.
function endDebuggerSessions(win: BrowserWindow): void {
  const dbg = win.webContents.debugger
  if (!dbg.isAttached()) {
    return
  }
  try {
    dbg.detach()
  } catch {
    // The page is being destroyed either way; a failed detach must not keep it alive.
  }
}
