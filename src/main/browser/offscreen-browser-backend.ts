import { randomUUID } from 'node:crypto'
import { ORCA_BROWSER_PARTITION } from '../../shared/constants'
import type { AgentBrowserBridge } from './agent-browser-bridge'
import type { BrowserBackend, BrowserBackendCreateTab, ParkedBrowserPage } from './browser-backend'
import type { BrowserManager } from './browser-manager'
import { browserSessionRegistry } from './browser-session-registry'
import { readOffscreenBrowserRetentionBudget } from './offscreen-browser-page-reclaim'
import { OffscreenBrowserPageReclaimer } from './offscreen-browser-page-reclaimer'
import {
  OffscreenBrowserOpenPages,
  type OffscreenBrowserPage
} from './offscreen-browser-open-pages'
import { materializeOffscreenBrowserRenderer } from './offscreen-browser-renderer-attachment'
import {
  loadOffscreenBrowserUrl,
  OFFSCREEN_BROWSER_WAKE_LOAD_BUDGET_MS
} from './offscreen-browser-window'

// Why (STA-4341): this backend is the lifecycle owner for headless browser
// pages. It keeps the page identity an agent holds (`browserPageId`, URL,
// worktree, profile) for as long as the page is open, but treats the renderer
// process behind it as a reclaimable resource: an idle page is parked (renderer
// destroyed, record kept) and woken on the next command that targets it.

export type OffscreenBrowserBackendOptions = {
  getAgentBrowserBridge?: () => AgentBrowserBridge | null
  /** Pages a client is streaming or that have a command in flight. */
  isPagePinned?: (browserPageId: string) => boolean
  /** Called when the set of open pages changes, so paired clients republish. */
  onPagesChanged?: (worktreeId: string | undefined) => void
  now?: () => number
}

export class OffscreenBrowserBackend implements BrowserBackend {
  private readonly pages = new OffscreenBrowserOpenPages()
  /** Renderer teardowns this backend initiated, keyed by page. Park and close
   *  both destroy the window on purpose, so the crash handler stands down for
   *  them — and a wake waits on one rather than racing it. */
  private readonly releasing = new Map<string, Promise<void>>()
  private readonly waking = new Map<string, Promise<boolean>>()
  private readonly reclaimer: OffscreenBrowserPageReclaimer

  constructor(
    private readonly browserManager: BrowserManager,
    private readonly options: OffscreenBrowserBackendOptions = {}
  ) {
    this.reclaimer = new OffscreenBrowserPageReclaimer({
      pages: this.pages,
      budget: readOffscreenBrowserRetentionBudget(),
      isReleasing: (browserPageId) => this.releasing.has(browserPageId),
      isWaking: (browserPageId) => this.waking.has(browserPageId),
      hasCertificateChallenge: (browserPageId) =>
        this.browserManager.getBrowserPageCertificateFailure(browserPageId) !== null,
      hasActiveDownload: (browserPageId) =>
        this.browserManager.hasActiveBrowserPageDownload(browserPageId),
      isHostPinned: (browserPageId) => this.options.isPagePinned?.(browserPageId) === true,
      park: (browserPageId) => this.parkPage(browserPageId),
      now: () => this.now()
    })
  }

  async createTab(params: BrowserBackendCreateTab): Promise<{ browserPageId: string }> {
    const browserPageId = params.browserPageId ?? randomUUID()
    // Why: closing drops the record before its teardown finishes, so a caller
    // reusing the id can register a new renderer that the old close then
    // unregisters. Let the release finish before claiming the id again.
    await this.releasing.get(browserPageId)
    if (this.pages.has(browserPageId)) {
      throw new Error(`Browser page ${browserPageId} already exists`)
    }
    // Why: profiles map to Electron partitions; using the profile's partition
    // makes cookies/storage persist in the same SQLite DB the desktop path uses.
    const profile = params.profileId
      ? browserSessionRegistry.getProfile(params.profileId)
      : browserSessionRegistry.getDefaultProfile()
    const url = params.url || 'about:blank'
    const page: OffscreenBrowserPage = {
      browserPageId,
      worktreeId: params.worktreeId,
      profileId: profile?.id ?? undefined,
      partition: profile?.partition ?? ORCA_BROWSER_PARTITION,
      url,
      title: '',
      window: null,
      activeWhenParked: false,
      loading: false,
      loadError: null,
      lastActivityAt: this.now()
    }
    this.pages.add(page)
    try {
      // Why: register the guest and return immediately so the new tab appears
      // without waiting for the page to finish loading. A failed load leaves
      // the (usable) tab open, matching how a normal browser tab survives one.
      this.materialize(page)
    } catch (error) {
      // Why: a create that never produced a usable renderer must not become an
      // owned page. Left in place it would occupy the retention budget, be
      // listed as parked, and make a retry with the same id fail as "already
      // exists" — while never having installed the crash handler that would
      // have cleaned it up.
      this.pages.delete(browserPageId)
      throw error
    }
    void this.loadPage(page, url).catch((error) => {
      console.warn(
        '[offscreen-browser] page load failed:',
        error instanceof Error ? error.message : String(error)
      )
    })
    this.reclaimer.reschedule()
    return { browserPageId }
  }

  async closeTab(browserPageId: string): Promise<void> {
    const page = this.pages.delete(browserPageId) ?? null
    this.waking.delete(browserPageId)
    await this.releaseRenderer(page, browserPageId)
    // Why: the closed page may have carried the scope's only active claim —
    // either the parked-active flag, or a live pointer whose teardown found no
    // other live tab to promote. A worktree with open pages and no active tab
    // breaks the one-selected-tab assumption every paired client renders on.
    // Gate on the book, not the bridge: getActivePageId resolves through
    // resolveActiveTab, which reassigns the active pointers as a side effect,
    // and its undefined scope means "anywhere" while the promotion is strict.
    // A scope holding a resident page needs no promotion — the live listing
    // marks one of its tabs active itself.
    if (page && !this.pages.resident().some((open) => open.worktreeId === page.worktreeId)) {
      this.pages.promoteParkedActive(page.worktreeId)
    }
    // Why: closing changes both residency and rank, and with the last page gone
    // this arms nothing at all.
    this.reclaimer.reschedule()
    // Why: closing a parked page has no WebContents teardown to piggyback on,
    // so nothing else tells paired clients the tab is gone — they would keep
    // showing a ghost until an operation against it failed.
    if (page) {
      this.options.onPagesChanged?.(page.worktreeId)
    }
  }

  /**
   * Make a page's renderer resident and restart its reclaim clock. Cheap and
   * idempotent for a page that never parked, so command routing can call it
   * unconditionally; that is also what serialises a command against a park
   * that is already tearing the renderer down.
   */
  async wakeTab(browserPageId: string): Promise<boolean> {
    const page = this.pages.get(browserPageId)
    if (!page) {
      return false
    }
    this.touch(page)
    // Why: a wake materializes the window before it swaps the helper session
    // and reloads the address, so the page looks resident well before it is
    // usable. Join an in-flight wake first or a second command runs against a
    // blank page whose session is still being torn down underneath it.
    const inFlight = this.waking.get(browserPageId)
    if (inFlight) {
      return inFlight
    }
    const releasing = this.releasing.get(browserPageId)
    if (!releasing && page.window && !page.window.isDestroyed()) {
      return true
    }
    const stillOwned = (): boolean => this.pages.get(browserPageId) === page
    const wake = (async (): Promise<boolean> => {
      await releasing
      // Why: identity, not presence — a close during the wake can be followed
      // by a create reusing the id, and reporting success then would hand the
      // original command a different page under the name it asked for.
      if (!stillOwned()) {
        return false
      }
      if (page.window && !page.window.isDestroyed()) {
        return true
      }
      page.activeWhenParked = false
      const previousWebContentsId = this.browserManager.getGuestWebContentsId(browserPageId)
      this.materialize(page)
      const bridge = this.options.getAgentBrowserBridge?.() ?? null
      const webContentsId = page.window?.webContents.id
      if (bridge && webContentsId != null) {
        // Why: same page id, new renderer — reuse the existing process-swap
        // path so the stale helper session and CDP proxy are torn down.
        await bridge.onProcessSwap(browserPageId, webContentsId, previousWebContentsId ?? undefined)
      }
      if (!stillOwned()) {
        return false
      }
      await this.loadPage(page, page.url, OFFSCREEN_BROWSER_WAKE_LOAD_BUDGET_MS).catch(() => {
        // A parked page whose URL no longer loads stays open and reports the
        // failure through the same load-error surface as a live page.
      })
      if (!stillOwned()) {
        return false
      }
      // Why: waking makes this page resident again, so the budget has to be
      // re-armed or the page it just displaced would never be reclaimed.
      this.touch(page)
      return true
    })()
    this.waking.set(browserPageId, wake)
    try {
      return await wake
    } finally {
      // Why: an abandoned wake can outlive a close and a replacement page's own
      // wake. Clearing the entry blindly would drop the replacement's lock, and
      // the next command would see a live window with no wake in flight and
      // drive a renderer that is still being rebuilt.
      if (this.waking.get(browserPageId) === wake) {
        this.waking.delete(browserPageId)
      }
    }
  }

  listParkedPages(worktreeId?: string): ParkedBrowserPage[] {
    return this.pages.listParked(worktreeId)
  }

  /** Open page ids in creation order — the stable order listings sort by. */
  listOpenPageIds(worktreeId?: string): string[] {
    return this.pages.openIds(worktreeId)
  }

  /** The parked page a page-less command should target in this worktree. */
  getParkedPageIdForImplicitTarget(worktreeId?: string): string | null {
    return this.pages.parkedIdForImplicitTarget(worktreeId)
  }

  // Why: quit only. The bridge's own destroyAllSessions() runs immediately
  // before this in the shutdown chain, so routing each page through the bridge
  // again would only re-close sessions that are already gone.
  destroyAll(): void {
    this.reclaimer.stop()
    for (const page of this.pages.all()) {
      this.browserManager.unregisterGuest(page.browserPageId)
      if (page.window && !page.window.isDestroyed()) {
        page.window.destroy()
      }
    }
    this.pages.clear()
    this.waking.clear()
  }

  /** Park every page the policy no longer wants resident. Exposed for tests. */
  async reclaimIdlePages(): Promise<string[]> {
    return this.reclaimer.sweep()
  }

  private async parkPage(browserPageId: string): Promise<void> {
    const page = this.pages.get(browserPageId)
    if (!page?.window || page.window.isDestroyed()) {
      return
    }
    const window = page.window
    // Why: the record's address is kept current by did-navigate, so parking
    // never has to guess it from a WebContents that may be sitting on the blank
    // page a failed load left behind.
    page.title = page.window.webContents.getTitle() ?? page.title
    // Why: a reclaimed renderer does not make a page that failed to load
    // healthy, and the failure becomes unreadable once the guest is
    // unregistered — so carry it onto the record.
    page.loadError = this.browserManager.getBrowserPageLoadError(browserPageId)
    page.activeWhenParked =
      this.options
        .getAgentBrowserBridge?.()
        ?.isActiveBrowserPage(browserPageId, page.worktreeId) === true
    // Why no abort once this starts: the veto is re-checked immediately before
    // this call, but teardown then awaits the helper session while the page
    // keeps running, so a download begun inside that window is still cancelled
    // by the unregister below — exactly as it would be if the tab were closed
    // at that instant. Backing out mid-teardown is worse: onTabClosed has
    // already destroyed the helper session and moved the worktree's active
    // pointer, so an abort leaves a resident page with reset automation state.
    await this.releaseRenderer(page, browserPageId)
    // Why: a wake awaiting this same release resumes BEFORE this line — its
    // reaction registered later on the same promise — and can have already
    // re-materialized the page. The park owns only the window it destroyed:
    // nulling the field blindly would drop the wake's fresh renderer off the
    // record (leaking it — close and destroyAll walk page.window), list the
    // page as parked and live at once, and let the wake report success while
    // loadPage no-ops on a nulled window.
    if (page.window !== window) {
      return
    }
    page.window = null
    if (page.activeWhenParked) {
      // Why: teardown promotes another live tab to active, which then parks
      // claiming the flag too. Only the newest claim may hold it.
      this.pages.claimParkedActive(browserPageId, page.worktreeId)
    }
  }

  // Why: teardown order matters — the bridge must destroy the helper session and
  // detach its debugger while the WebContents is still alive and still mapped,
  // or the session, its CDP proxy and its listening port outlive the page.
  private async releaseRenderer(
    page: OffscreenBrowserPage | null,
    browserPageId: string
  ): Promise<void> {
    const pending = this.releasing.get(browserPageId)
    if (pending) {
      await pending
      return
    }
    const release = this.runReleaseRenderer(page, browserPageId)
    this.releasing.set(browserPageId, release)
    try {
      await release
    } finally {
      if (this.releasing.get(browserPageId) === release) {
        this.releasing.delete(browserPageId)
      }
    }
  }

  private async runReleaseRenderer(
    page: OffscreenBrowserPage | null,
    browserPageId: string
  ): Promise<void> {
    const bridge = this.options.getAgentBrowserBridge?.() ?? null
    const webContentsId = this.browserManager.getGuestWebContentsId(browserPageId)
    if (bridge && webContentsId != null) {
      await bridge.onTabClosed(webContentsId)
    }
    this.browserManager.unregisterGuest(browserPageId)
    if (page?.window && !page.window.isDestroyed()) {
      page.window.destroy()
    }
  }

  private materialize(page: OffscreenBrowserPage): void {
    materializeOffscreenBrowserRenderer(page, {
      isDeliberateTeardown: (browserPageId) => this.releasing.has(browserPageId),
      onRendererLost: (webContentsId) => {
        this.pages.delete(page.browserPageId)
        // Why: an unprompted renderer loss must reclaim the helper session too,
        // or a crash loop leaks one session, CDP proxy and listening port per
        // page — the same leak the deliberate teardown path fixes.
        void this.options
          .getAgentBrowserBridge?.()
          ?.onTabClosed(webContentsId)
          .catch(() => {})
        this.browserManager.unregisterGuest(page.browserPageId)
        this.reclaimer.reschedule()
      },
      registerGuest: (webContentsId) => {
        const profile = page.profileId ? browserSessionRegistry.getProfile(page.profileId) : null
        this.browserManager.registerOffscreenGuest({
          browserPageId: page.browserPageId,
          worktreeId: page.worktreeId,
          sessionProfileId: page.profileId ?? null,
          userAgentMode: profile?.userAgentMode,
          webContentsId
        })
      }
    })
  }

  private async loadPage(
    page: OffscreenBrowserPage,
    url: string,
    timeoutMs?: number
  ): Promise<void> {
    const win = page.window
    if (!win || win.isDestroyed()) {
      return
    }
    page.loading = true
    try {
      await loadOffscreenBrowserUrl(win, url, timeoutMs)
    } finally {
      page.loading = false
    }
    if (page.window === win && !win.isDestroyed()) {
      page.title = win.webContents.getTitle() ?? page.title
      // Why: the reclaim clock must start when the page is ready, not when the
      // create call returned, or a slow load can be parked mid-flight.
      this.touch(page)
    }
  }

  // Why: every activity stamp moves the next reclaim deadline, so pairing the
  // two here makes it impossible to record use without re-arming the budget.
  private touch(page: OffscreenBrowserPage): void {
    page.lastActivityAt = this.now()
    this.reclaimer.reschedule()
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
}
