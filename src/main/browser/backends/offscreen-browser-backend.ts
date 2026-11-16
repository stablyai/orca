import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import '../../../shared/constants'
import { ORCA_BROWSER_PARTITION } from '../../../shared/browser/browser-session-partition'
import { ORCA_BROWSER_GUEST_WEB_PREFERENCES } from '../../../shared/browser/guest-lifecycle/browser-guest-web-preferences'
import { mapSettledWithConcurrency } from '../../../shared/concurrency/map-with-concurrency'
import type { BrowserBackend, BrowserBackendCreateTab } from '../browser-backend'
import type { BrowserManager } from '../guest-lifecycle/manager/browser-manager'
import type { AgentBrowserBridge } from '../agent-browser/agent-browser-bridge'
import { browserSessionRegistry } from '../sessions/profiles/browser-session-registry'
import { installBrowserJavaScriptDialogs } from '../guest-lifecycle/prompts/browser-javascript-dialogs'
import {
  loadPageWhenReady,
  whenBrowserExtensionsStartFor
} from '../extensions/profile-sessions/browser-extension-page-start'
import type { ServeBrowserPageState } from '../../runtime/browser/headless/serve-browser-tab-layout'
import { followPublicationLeasesWithFrameRate } from './offscreen-page-frame-rate'
import { mustKeepOffscreenPage, OffscreenPageIdleClock } from './offscreen-page-idle-freeing'

// orca serve has no renderer for webviews; hidden offscreen BrowserWindows host its pages.
// Headless Linux requires Xvfb; Electron --headless segfaults.

const DEFAULT_VIEWPORT_WIDTH = 1280
const DEFAULT_VIEWPORT_HEIGHT = 800
const LOAD_TIMEOUT_MS = 30_000
const OWNER_RETIREMENT_CONCURRENCY = 4

type FreedPage = { worktreeId: string; entries: Electron.NavigationEntry[]; index: number }

export class OffscreenBrowserBackend implements BrowserBackend {
  private readonly windowsByPageId = new Map<string, BrowserWindow>()
  // Reject creates once shutdown starts so pages cannot escape destroyAll's ownership snapshot.
  private shutdownStarted = false
  private readonly pendingOwnerRetirements = new Set<Promise<void>>()
  // A freed page's back/forward list, so waking it under the same id feels like it never left.
  private readonly freedPages = new Map<string, FreedPage>()
  private readonly idleClock: OffscreenPageIdleClock

  constructor(
    private readonly browserManager: BrowserManager,
    private readonly options: {
      getAgentBrowserBridge?: () => Pick<
        AgentBrowserBridge,
        'onPageClosed' | 'isRoutedPage' | 'holdsPageNetworkState'
      > | null
      onPageNavigated?: (page: ServeBrowserPageState) => void
      /** Only pages whose tab is saved are freed, since their next use restores them from it. */
      isPageSaved?: (page: { browserPageId: string; worktreeId: string }) => boolean
      /** How long a page may go without a command, capture or viewer before it is freed; 0 keeps it. */
      idleFreeMs?: () => number
    } = {}
  ) {
    this.idleClock = new OffscreenPageIdleClock(() =>
      options.isPageSaved ? (options.idleFreeMs?.() ?? 0) : 0
    )
  }

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
    if (profile) {
      // A server page starts its profile's extensions, as a desktop tab does.
      browserSessionRegistry.attachExtensions(profile.id)
    }
    const extensionsReady = profile ? whenBrowserExtensionsStartFor(profile.id) : null

    const win = new BrowserWindow({
      show: false,
      width: DEFAULT_VIEWPORT_WIDTH,
      height: DEFAULT_VIEWPORT_HEIGHT,
      webPreferences: {
        ...ORCA_BROWSER_GUEST_WEB_PREFERENCES,
        partition,
        // A hidden window on a headless display has no surface to draw into, so captures came back blank.
        offscreen: true,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // Sandboxed and without Node, this only runs the session's preloads in iframes too.
        nodeIntegrationInSubFrames: true
      }
    })

    // Nothing reads offscreen paint frames: CDP captures and screencasts copy from the compositor,
    // and delivering every animation frame to main costs hundreds of MB per animated tab.
    win.webContents.stopPainting()
    followPublicationLeasesWithFrameRate(win.webContents)
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
      this.idleClock.untrack(browserPageId)
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

    if (worktreeId) {
      const onIdle = (): void => this.freeIdlePage(browserPageId, worktreeId, win, onIdle)
      this.idleClock.track(browserPageId, win.webContents, onIdle)
    }

    const freed = this.freedPages.get(browserPageId)
    this.freedPages.delete(browserPageId)
    const url = params.url || 'about:blank'
    // A woken page comes back with its back/forward list; a failed or superseded restore still
    // left that history, so only an empty page needs the saved URL.
    const load = (): Promise<void> =>
      freed
        ? win.webContents.navigationHistory
            .restore({ entries: freed.entries, index: freed.index })
            .catch(() =>
              win.webContents.navigationHistory.length() > 0 ? undefined : this.loadUrl(win, url)
            )
        : this.loadUrl(win, url)
    const loaded = extensionsReady
      ? loadPageWhenReady(win.webContents, extensionsReady, load)
      : load()
    void loaded.catch((error) => {
      console.warn(
        '[offscreen-browser] page load failed:',
        error instanceof Error ? error.message : String(error)
      )
    })

    return { browserPageId }
  }

  async closeTab(browserPageId: string): Promise<void> {
    this.freedPages.delete(browserPageId)
    await this.releasePage(browserPageId, 'page-closed')
  }

  /** Frees an unused page's renderer; its saved tab stays listed and the next use restores it. */
  private freeIdlePage(
    browserPageId: string,
    worktreeId: string,
    win: BrowserWindow,
    onIdle: () => void
  ): void {
    if (this.windowsByPageId.get(browserPageId) !== win || win.isDestroyed()) {
      return
    }
    const isSaved = this.options.isPageSaved
    if (
      !isSaved?.({ browserPageId, worktreeId }) ||
      mustKeepOffscreenPage(browserPageId, win.webContents, {
        browserManager: this.browserManager,
        bridge: this.options.getAgentBrowserBridge?.() ?? null
      })
    ) {
      this.idleClock.restart(browserPageId, win.webContents, onIdle)
      return
    }
    // Tabs closed while freed never come back through this backend; drop their history here.
    for (const [pageId, page] of this.freedPages) {
      if (!isSaved({ browserPageId: pageId, worktreeId: page.worktreeId })) {
        this.freedPages.delete(pageId)
      }
    }
    const history = win.webContents.navigationHistory
    this.freedPages.set(browserPageId, {
      worktreeId,
      entries: history.getAllEntries(),
      index: history.getActiveIndex()
    })
    // Downloads outlive the page, as they do when its renderer dies.
    void this.releasePage(browserPageId, 'guest-destroyed')
  }

  private async releasePage(
    browserPageId: string,
    reason: 'page-closed' | 'guest-destroyed'
  ): Promise<void> {
    const win = this.windowsByPageId.get(browserPageId)
    this.windowsByPageId.delete(browserPageId)
    this.idleClock.untrack(browserPageId)
    this.browserManager.unregisterGuest(browserPageId, reason)
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
