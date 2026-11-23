import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { BrowserWindow } from 'electron'
import '../../../shared/orca-profiles/constants'
import { ORCA_BROWSER_GUEST_WEB_PREFERENCES } from '../../../shared/browser/guest-lifecycle/browser-guest-web-preferences'
import { mapSettledWithConcurrency } from '../../../shared/concurrency/map-with-concurrency'
import type { BrowserBackend, BrowserBackendCreateTab } from '../browser-backend'
import type { BrowserManager } from '../guest-lifecycle/manager/browser-manager'
import type { AgentBrowserBridge } from '../agent-browser/agent-browser-bridge'
import { BrowserError } from '../browser-error'
import { browserSessionRegistry } from '../sessions/profiles/browser-session-registry'
import { installBrowserJavaScriptDialogs } from '../guest-lifecycle/prompts/browser-javascript-dialogs'
import { whenBrowserExtensionsStartFor } from '../extensions/profile-sessions/browser-extension-page-start'
import {
  loadPageWhenReady,
  startHeldLoad
} from '../extensions/profile-sessions/browser-page-held-first-load'
import type { ServeBrowserPageState } from '../../runtime/browser/headless/serve-browser-tab-layout'
import { followPublicationLeasesWithFrameRate } from './offscreen-page-frame-rate'
import { mustKeepOffscreenPage, OffscreenPageIdleClock } from './offscreen-page-idle-freeing'
import { WEB_CONTENTS_MAX_LISTENERS_PER_EVENT } from '../../window/web-contents-listener-budget'
import { loadOffscreenPageUrl } from './offscreen-page-load'

// orca serve has no renderer for webviews; hidden offscreen BrowserWindows host its pages.
// Headless Linux requires Xvfb; Electron --headless segfaults.

const DEFAULT_VIEWPORT_WIDTH = 1280
const DEFAULT_VIEWPORT_HEIGHT = 800
const OWNER_RETIREMENT_CONCURRENCY = 4
const requestedUrlByWindow = new WeakMap<BrowserWindow, string>()

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
        'onPageClosed' | 'onProcessSwap' | 'isRoutedPage' | 'holdsPageNetworkState'
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
    // A deleted profile must not fall back to Default's cookie jar, as on desktop.
    if (!profile) {
      throw new BrowserError(
        'invalid_argument',
        `Browser profile ${params.profileId} was not found`
      )
    }
    const { partition } = profile
    // A server page starts its profile's extensions, as a desktop tab does.
    browserSessionRegistry.attachExtensions(profile.id)
    const extensionsReady = whenBrowserExtensionsStartFor(profile.id)

    const win = new BrowserWindow({
      show: false,
      width: DEFAULT_VIEWPORT_WIDTH,
      height: DEFAULT_VIEWPORT_HEIGHT,
      webPreferences: {
        ...ORCA_BROWSER_GUEST_WEB_PREFERENCES,
        partition,
        // Reports typed form input, so Memory Saver keeps these pages as it keeps desktop ones.
        preload: join(__dirname, 'browser-offscreen-page-preload.js'),
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
    // Same browser subsystems watch it as a desktop guest, so the same per-event budget.
    win.webContents.setMaxListeners(WEB_CONTENTS_MAX_LISTENERS_PER_EVENT)
    followPublicationLeasesWithFrameRate(win.webContents)
    this.windowsByPageId.set(browserPageId, win)
    requestedUrlByWindow.set(win, params.url)
    // Server pages have no window to ask in; agents and phones answer their dialogs.
    installBrowserJavaScriptDialogs(win.webContents, () => null)

    // Do not wait for navigation: slow or failed loads must leave an operable tab.
    const registered = this.browserManager.registerOffscreenGuest({
      browserPageId,
      worktreeId: params.worktreeId,
      sessionProfileId: profile.id,
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
      const report = (): void => {
        // A page replaced by a profile switch must not save its last address over the new one's.
        if (this.windowsByPageId.get(browserPageId) !== win) {
          return
        }
        onPageNavigated({
          worktreeId,
          pageId: browserPageId,
          url: win.webContents.getURL(),
          title: win.webContents.getTitle()
        })
      }
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
              win.webContents.navigationHistory.length() > 0
                ? undefined
                : loadOffscreenPageUrl(win, url)
            )
        : loadOffscreenPageUrl(win, url)
    const loaded = extensionsReady
      ? loadPageWhenReady(
          win.webContents,
          extensionsReady,
          (requested) =>
            requested ? startHeldLoad(win.webContents, requested, freed ?? null) : load(),
          { history: freed }
        )
      : load()
    void loaded.catch((error) => {
      console.warn(
        '[offscreen-browser] page load failed:',
        error instanceof Error ? error.message : String(error)
      )
    })

    return { browserPageId }
  }

  async setTabProfile(browserPageId: string, profileId: string): Promise<void> {
    const win = this.windowsByPageId.get(browserPageId)
    if (!win || win.isDestroyed()) {
      throw new Error(`Browser page ${browserPageId} is not running`)
    }
    // Deleted while the switch waited: refuse it, or the page would reopen in the default session.
    if (!browserSessionRegistry.getProfile(profileId)) {
      throw new BrowserError('invalid_argument', `Browser profile ${profileId} was not found`)
    }
    const previousWebContentsId = win.webContents.id
    const worktreeId = this.browserManager.getWorktreeIdForTab(browserPageId)
    // A page still holding its first load for extensions has no URL yet.
    const url = win.webContents.getURL() || (requestedUrlByWindow.get(win) ?? '')
    // Hand the id over in one synchronous step so no command finds the page missing in between.
    this.windowsByPageId.delete(browserPageId)
    this.idleClock.untrack(browserPageId)
    this.browserManager.unregisterGuest(browserPageId, 'guest-destroyed')
    try {
      const created = this.createTab({ browserPageId, url, worktreeId, profileId })
      const nextWebContentsId = this.getWebContentsId(browserPageId)
      if (nextWebContentsId !== null) {
        // Keeps the agent's routes on the page, as a desktop webview's process swap does.
        await this.options
          .getAgentBrowserBridge?.()
          ?.onProcessSwap(browserPageId, nextWebContentsId, previousWebContentsId)
          .catch(() => {})
      }
      await created
    } finally {
      if (!win.isDestroyed()) {
        endDebuggerSessions(win)
        win.destroy()
      }
    }
  }

  async closeTab(browserPageId: string): Promise<void> {
    this.freedPages.delete(browserPageId)
    // A popup one of these pages opened is listed as a tab but is a window; close it as window.close() would.
    if (
      !this.windowsByPageId.has(browserPageId) &&
      (await this.browserManager.closePopupPage(browserPageId))
    ) {
      return
    }
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

  /** Running pages in this profile. */
  pageIdsInProfile(profileId: string): string[] {
    return [...this.windowsByPageId.keys()].filter(
      (pageId) => this.browserManager.getSessionProfileIdForTab(pageId) === profileId
    )
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
