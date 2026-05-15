/* eslint-disable max-lines -- Why: this file is a command adapter for one external surface, Agent Browser automation. It stays separate from OrcaRuntimeService so runtime state does not grow further while browser routing remains easy to scan in one place. */
import { randomUUID } from 'crypto'
import { ipcMain, type BrowserWindow } from 'electron'
import { getRepoIdFromWorktreeId } from '../../shared/worktree-id'
import type {
  BrowserBackResult,
  BrowserCaptureStartResult,
  BrowserCheckResult,
  BrowserCaptureStopResult,
  BrowserClearResult,
  BrowserClickResult,
  BrowserConsoleResult,
  BrowserCookieDeleteResult,
  BrowserCookieGetResult,
  BrowserCookieSetResult,
  BrowserDetectProfilesResult,
  BrowserDragResult,
  BrowserEvalResult,
  BrowserFillResult,
  BrowserFocusResult,
  BrowserGeolocationResult,
  BrowserGotoResult,
  BrowserHoverResult,
  BrowserInterceptDisableResult,
  BrowserInterceptEnableResult,
  BrowserKeypressResult,
  BrowserNetworkLogResult,
  BrowserPdfResult,
  BrowserProfileClearDefaultCookiesResult,
  BrowserProfileCreateResult,
  BrowserProfileDeleteResult,
  BrowserProfileImportFromBrowserResult,
  BrowserProfileListResult,
  BrowserReloadResult,
  BrowserScreenshotResult,
  BrowserScrollResult,
  BrowserSelectAllResult,
  BrowserSelectResult,
  BrowserSnapshotResult,
  BrowserTabCurrentResult,
  BrowserTabListResult,
  BrowserTabProfileCloneResult,
  BrowserTabProfileShowResult,
  BrowserTabSetProfileResult,
  BrowserTabShowResult,
  BrowserTabSwitchResult,
  BrowserTypeResult,
  BrowserUploadResult,
  BrowserViewportResult,
  BrowserWaitResult
} from '../../shared/runtime-types'
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import { browserManager } from '../browser/browser-manager'
import { BrowserError } from '../browser/cdp-bridge'
import { browserSessionRegistry } from '../browser/browser-session-registry'
import {
  detectInstalledBrowsers,
  importCookiesFromBrowser,
  selectBrowserProfile
} from '../browser/browser-cookie-import'
import { waitForTabRegistration } from '../ipc/browser'

export type BrowserCommandTargetParams = {
  worktree?: string
  page?: string
}

type ResolvedBrowserCommandTarget = {
  worktreeId?: string
  browserPageId?: string
}

export type RuntimeBrowserCommandHost = {
  getAgentBrowserBridge(): AgentBrowserBridge | null
  resolveWorktreeSelector(selector: string): Promise<{ id: string }>
  getAuthoritativeWindow(): BrowserWindow
  getAvailableAuthoritativeWindow(): BrowserWindow | null
}

export class RuntimeBrowserCommands {
  constructor(private readonly host: RuntimeBrowserCommandHost) {}

  private requireAgentBrowserBridge(): AgentBrowserBridge {
    const bridge = this.host.getAgentBrowserBridge()
    if (!bridge) {
      throw new BrowserError('browser_no_tab', 'No browser session is active')
    }
    return bridge
  }

  // Why: the CLI sends worktree selectors (e.g. "path:/Users/...") but the
  // bridge stores worktreeIds in "repoId::path" format (from the renderer's
  // Zustand store). This helper resolves the selector to the store-compatible
  // ID so the bridge can filter tabs correctly.
  private async resolveBrowserWorktreeId(selector?: string): Promise<string | undefined> {
    if (!selector) {
      // Why: after app restart, webviews only mount when the browser pane is visible.
      // Without --worktree, we still need to activate the view so persisted tabs
      // become operable via registerGuest.
      const bridge = this.host.getAgentBrowserBridge()
      if (bridge && bridge.getRegisteredTabs().size === 0) {
        try {
          const win = this.host.getAuthoritativeWindow()
          win.webContents.send('browser:activateView', {})
          await new Promise((resolve) => setTimeout(resolve, 500))
        } catch {
          // Window may not exist yet (e.g. during startup or in tests)
        }
      }
      return undefined
    }

    const worktreeId = (await this.host.resolveWorktreeSelector(selector)).id
    // Why: explicit worktree selectors are user intent, so resolution errors
    // must surface instead of silently widening browser routing scope. Only the
    // activation step remains best-effort because missing windows during tests
    // or startup should not erase the validated worktree target itself.
    const bridge = this.host.getAgentBrowserBridge()
    if (bridge && bridge.getRegisteredTabs(worktreeId).size === 0) {
      try {
        await this.ensureBrowserWorktreeActive(worktreeId)
      } catch {
        // Fall through with the validated worktree id so downstream routing
        // still stays scoped to the caller's explicit selector.
      }
    }
    return worktreeId
  }

  private async resolveBrowserCommandTarget(
    params: BrowserCommandTargetParams
  ): Promise<ResolvedBrowserCommandTarget> {
    const browserPageId =
      typeof params.page === 'string' && params.page.length > 0 ? params.page : undefined
    if (!browserPageId) {
      return {
        worktreeId: await this.resolveBrowserWorktreeId(params.worktree)
      }
    }

    return {
      // Why: explicit browserPageId is already a stable tab identity, so we do
      // not auto-resolve cwd worktree scoping on top of it. Only honor an
      // explicit --worktree when the caller asked for that extra validation.
      worktreeId: params.worktree
        ? await this.resolveBrowserWorktreeId(params.worktree)
        : undefined,
      browserPageId
    }
  }

  // Why: browser tabs only mount (and become operable) when their worktree is
  // the active worktree in the renderer AND activeTabType is 'browser'. If either
  // condition is false, the webview stays in display:none and Electron won't start
  // its guest process — dom-ready never fires, registerGuest never runs, and CLI
  // browser commands fail with "CDP connection refused".
  private async ensureBrowserWorktreeActive(worktreeId: string): Promise<void> {
    const win = this.host.getAuthoritativeWindow()
    const repoId = getRepoIdFromWorktreeId(worktreeId)
    if (!repoId) {
      return
    }
    win.webContents.send('ui:activateWorktree', { repoId, worktreeId })
    // Why: switching worktree alone sets activeView='terminal'. Browser webviews
    // won't mount until activeTabType is 'browser'. Send a second IPC to flip it.
    win.webContents.send('browser:activateView', { worktreeId })
    // Why: give the renderer time to mount the webview after switching worktrees.
    // The webview needs to attach and fire dom-ready before registerGuest runs.
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  // Why: agent-browser drives navigation via CDP, which bypasses Electron's
  // webview event system. The renderer's did-navigate / page-title-updated
  // listeners never fire, leaving the Zustand store (and thus the Orca UI's
  // address bar and tab title) stale. Push updates from main → renderer after
  // any navigation-causing command so the UI stays in sync.
  private notifyRendererNavigation(browserPageId: string, url: string, title: string): void {
    try {
      const win = this.host.getAuthoritativeWindow()
      win.webContents.send('browser:navigation-update', { browserPageId, url, title })
    } catch {
      // Window may not exist during shutdown
    }
  }

  // Why: `tabSwitch` only flips the bridge's `activeWebContentsId` — it
  // does not surface the browser pane in the renderer. Without --focus, the
  // switch is invisible to the user. With --focus, we send a dedicated IPC
  // so the renderer can update its per-worktree active-tab state.
  //
  // Why this IPC carries `worktreeId` instead of letting the renderer
  // dispatch `setActiveWorktree`: multiple agents drive browsers in parallel
  // worktrees. A global focus call from agent X would steal the user's
  // screen from agent Y's worktree. The renderer-side handler
  // (focusBrowserTabInWorktree) updates per-worktree state unconditionally
  // and only flips globals when the user is already on the targeted
  // worktree. Cross-worktree --focus calls pre-stage silently.
  private notifyRendererBrowserPaneFocus(
    worktreeId: string | undefined,
    browserPageId: string
  ): void {
    try {
      const win = this.host.getAuthoritativeWindow()
      win.webContents.send('browser:pane-focus', {
        worktreeId: worktreeId ?? null,
        browserPageId
      })
    } catch {
      // Window may not exist during shutdown
    }
  }

  async browserSnapshot(params: BrowserCommandTargetParams): Promise<BrowserSnapshotResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().snapshot(target.worktreeId, target.browserPageId)
  }

  async browserClick(
    params: { element: string } & BrowserCommandTargetParams
  ): Promise<BrowserClickResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    const bridge = this.requireAgentBrowserBridge()
    const result = await bridge.click(params.element, target.worktreeId, target.browserPageId)
    // Why: clicks can trigger navigation (e.g. submitting a form, clicking a link).
    // Read the target tab's live URL/title after the click and push to the
    // renderer so the UI updates even when automation targeted a non-active page.
    const page = bridge.getPageInfo(target.worktreeId, target.browserPageId)
    if (page) {
      this.notifyRendererNavigation(page.browserPageId, page.url, page.title)
    }
    return result
  }

  async browserGoto(
    params: { url: string } & BrowserCommandTargetParams
  ): Promise<BrowserGotoResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    const bridge = this.requireAgentBrowserBridge()
    const result = await bridge.goto(params.url, target.worktreeId, target.browserPageId)
    const pageId = bridge.getActivePageId(target.worktreeId, target.browserPageId)
    if (pageId) {
      this.notifyRendererNavigation(pageId, result.url, result.title)
    }
    return result
  }

  async browserFill(
    params: {
      element: string
      value: string
    } & BrowserCommandTargetParams
  ): Promise<BrowserFillResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().fill(
      params.element,
      params.value,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserType(
    params: { input: string } & BrowserCommandTargetParams
  ): Promise<BrowserTypeResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().type(
      params.input,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserSelect(
    params: {
      element: string
      value: string
    } & BrowserCommandTargetParams
  ): Promise<BrowserSelectResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().select(
      params.element,
      params.value,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserScroll(
    params: { direction: 'up' | 'down'; amount?: number } & BrowserCommandTargetParams
  ): Promise<BrowserScrollResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().scroll(
      params.direction,
      params.amount,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserBack(params: BrowserCommandTargetParams): Promise<BrowserBackResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    const bridge = this.requireAgentBrowserBridge()
    const result = await bridge.back(target.worktreeId, target.browserPageId)
    const pageId = bridge.getActivePageId(target.worktreeId, target.browserPageId)
    if (pageId) {
      this.notifyRendererNavigation(pageId, result.url, result.title)
    }
    return result
  }

  async browserReload(params: BrowserCommandTargetParams): Promise<BrowserReloadResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    const bridge = this.requireAgentBrowserBridge()
    const result = await bridge.reload(target.worktreeId, target.browserPageId)
    const pageId = bridge.getActivePageId(target.worktreeId, target.browserPageId)
    if (pageId) {
      this.notifyRendererNavigation(pageId, result.url, result.title)
    }
    return result
  }

  async browserScreenshot(
    params: {
      format?: 'png' | 'jpeg'
    } & BrowserCommandTargetParams
  ): Promise<BrowserScreenshotResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().screenshot(
      params.format,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserEval(
    params: { expression: string } & BrowserCommandTargetParams
  ): Promise<BrowserEvalResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().evaluate(
      params.expression,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserTabList(params: { worktree?: string }): Promise<BrowserTabListResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    const result = this.requireAgentBrowserBridge().tabList(worktreeId)
    return {
      tabs: result.tabs.map((tab) => this.enrichBrowserTabInfo(tab))
    }
  }

  async browserTabShow(params: { page: string; worktree?: string }): Promise<BrowserTabShowResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return { tab: this.describeBrowserTab(params.page, worktreeId) }
  }

  async browserTabCurrent(params: { worktree?: string }): Promise<BrowserTabCurrentResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    const browserPageId = this.requireAgentBrowserBridge().getActivePageId(worktreeId)
    if (!browserPageId) {
      throw new BrowserError('browser_no_tab', 'No browser tab open in this worktree')
    }
    return { tab: this.describeBrowserTab(browserPageId, worktreeId) }
  }

  async browserTabSwitch(
    params: {
      index?: number
      focus?: boolean
    } & BrowserCommandTargetParams
  ): Promise<BrowserTabSwitchResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    const bridge = this.requireAgentBrowserBridge()
    const result = await bridge.tabSwitch(params.index, target.worktreeId, target.browserPageId)
    if (params.focus) {
      // Why: prefer the explicit --worktree the caller passed; fall back to
      // the bridge's owning-worktree map for the just-switched tab. The
      // owning worktree is what the renderer needs to scope the focus to.
      // The renderer NEVER yanks the user across worktrees on this signal
      // (see focusBrowserTabInWorktree).
      const worktreeId =
        target.worktreeId ?? browserManager.getWorktreeIdForTab(result.browserPageId) ?? undefined
      this.notifyRendererBrowserPaneFocus(worktreeId, result.browserPageId)
    }
    return result
  }

  async browserHover(
    params: { element: string } & BrowserCommandTargetParams
  ): Promise<BrowserHoverResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().hover(
      params.element,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserDrag(
    params: {
      from: string
      to: string
    } & BrowserCommandTargetParams
  ): Promise<BrowserDragResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().drag(
      params.from,
      params.to,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserUpload(
    params: { element: string; files: string[] } & BrowserCommandTargetParams
  ): Promise<BrowserUploadResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().upload(
      params.element,
      params.files,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserWait(
    params: {
      selector?: string
      timeout?: number
      text?: string
      url?: string
      load?: string
      fn?: string
      state?: string
    } & BrowserCommandTargetParams
  ): Promise<BrowserWaitResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    const { worktree: _, page: __, ...options } = params
    return this.requireAgentBrowserBridge().wait(options, target.worktreeId, target.browserPageId)
  }

  async browserCheck(
    params: { element: string; checked: boolean } & BrowserCommandTargetParams
  ): Promise<BrowserCheckResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().check(
      params.element,
      params.checked,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserFocus(
    params: { element: string } & BrowserCommandTargetParams
  ): Promise<BrowserFocusResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().focus(
      params.element,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserClear(
    params: { element: string } & BrowserCommandTargetParams
  ): Promise<BrowserClearResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().clear(
      params.element,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserSelectAll(
    params: { element: string } & BrowserCommandTargetParams
  ): Promise<BrowserSelectAllResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().selectAll(
      params.element,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserKeypress(
    params: { key: string } & BrowserCommandTargetParams
  ): Promise<BrowserKeypressResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().keypress(
      params.key,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserPdf(params: BrowserCommandTargetParams): Promise<BrowserPdfResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().pdf(target.worktreeId, target.browserPageId)
  }

  async browserFullScreenshot(
    params: {
      format?: 'png' | 'jpeg'
    } & BrowserCommandTargetParams
  ): Promise<BrowserScreenshotResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().fullPageScreenshot(
      params.format,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Cookie management ──

  async browserCookieGet(
    params: { url?: string } & BrowserCommandTargetParams
  ): Promise<BrowserCookieGetResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().cookieGet(
      params.url,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserCookieSet(
    params: {
      name: string
      value: string
      domain?: string
      path?: string
      secure?: boolean
      httpOnly?: boolean
      sameSite?: string
      expires?: number
    } & BrowserCommandTargetParams
  ): Promise<BrowserCookieSetResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().cookieSet(
      params,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserCookieDelete(
    params: {
      name: string
      domain?: string
      url?: string
    } & BrowserCommandTargetParams
  ): Promise<BrowserCookieDeleteResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().cookieDelete(
      params.name,
      params.domain,
      params.url,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Viewport ──

  async browserSetViewport(
    params: {
      width: number
      height: number
      deviceScaleFactor?: number
      mobile?: boolean
    } & BrowserCommandTargetParams
  ): Promise<BrowserViewportResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().setViewport(
      params.width,
      params.height,
      params.deviceScaleFactor,
      params.mobile,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Geolocation ──

  async browserSetGeolocation(
    params: {
      latitude: number
      longitude: number
      accuracy?: number
    } & BrowserCommandTargetParams
  ): Promise<BrowserGeolocationResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().setGeolocation(
      params.latitude,
      params.longitude,
      params.accuracy,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Request interception ──

  async browserInterceptEnable(
    params: {
      patterns?: string[]
    } & BrowserCommandTargetParams
  ): Promise<BrowserInterceptEnableResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().interceptEnable(
      params.patterns,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserInterceptDisable(
    params: BrowserCommandTargetParams
  ): Promise<BrowserInterceptDisableResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().interceptDisable(
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserInterceptList(params: BrowserCommandTargetParams): Promise<{ requests: unknown[] }> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().interceptList(target.worktreeId, target.browserPageId)
  }

  // ── Console/network capture ──

  async browserCaptureStart(
    params: BrowserCommandTargetParams
  ): Promise<BrowserCaptureStartResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().captureStart(target.worktreeId, target.browserPageId)
  }

  async browserCaptureStop(params: BrowserCommandTargetParams): Promise<BrowserCaptureStopResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().captureStop(target.worktreeId, target.browserPageId)
  }

  async browserConsoleLog(
    params: { limit?: number } & BrowserCommandTargetParams
  ): Promise<BrowserConsoleResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().consoleLog(
      params.limit,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserNetworkLog(
    params: { limit?: number } & BrowserCommandTargetParams
  ): Promise<BrowserNetworkLogResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().networkLog(
      params.limit,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Additional core commands ──

  async browserDblclick(
    params: { element: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().dblclick(
      params.element,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserForward(params: BrowserCommandTargetParams): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().forward(target.worktreeId, target.browserPageId)
  }

  async browserScrollIntoView(
    params: { element: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().scrollIntoView(
      params.element,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserGet(
    params: {
      what: string
      selector?: string
    } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().get(
      params.what,
      params.selector,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserIs(
    params: { what: string; selector: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().is(
      params.what,
      params.selector,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Keyboard insert text ──

  async browserKeyboardInsertText(
    params: { text: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().keyboardInsertText(
      params.text,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Mouse commands ──

  async browserMouseMove(
    params: { x: number; y: number } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().mouseMove(
      params.x,
      params.y,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserMouseDown(
    params: { button?: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().mouseDown(
      params.button,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserMouseUp(params: { button?: string } & BrowserCommandTargetParams): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().mouseUp(
      params.button,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserMouseWheel(
    params: {
      dy: number
      dx?: number
    } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().mouseWheel(
      params.dy,
      params.dx,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Find (semantic locators) ──

  async browserFind(
    params: {
      locator: string
      value: string
      action: string
      text?: string
    } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().find(
      params.locator,
      params.value,
      params.action,
      params.text,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Set commands ──

  async browserSetDevice(params: { name: string } & BrowserCommandTargetParams): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().setDevice(
      params.name,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserSetOffline(
    params: { state?: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().setOffline(
      params.state,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserSetHeaders(
    params: { headers: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().setHeaders(
      params.headers,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserSetCredentials(
    params: {
      user: string
      pass: string
    } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().setCredentials(
      params.user,
      params.pass,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserSetMedia(
    params: {
      colorScheme?: string
      reducedMotion?: string
    } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().setMedia(
      params.colorScheme,
      params.reducedMotion,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Clipboard commands ──

  async browserClipboardRead(params: BrowserCommandTargetParams): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().clipboardRead(target.worktreeId, target.browserPageId)
  }

  async browserClipboardWrite(
    params: { text: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().clipboardWrite(
      params.text,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Dialog commands ──

  async browserDialogAccept(
    params: { text?: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().dialogAccept(
      params.text,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserDialogDismiss(params: BrowserCommandTargetParams): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().dialogDismiss(target.worktreeId, target.browserPageId)
  }

  // ── Storage commands ──

  async browserStorageLocalGet(
    params: { key: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().storageLocalGet(
      params.key,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserStorageLocalSet(
    params: {
      key: string
      value: string
    } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().storageLocalSet(
      params.key,
      params.value,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserStorageLocalClear(params: BrowserCommandTargetParams): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().storageLocalClear(
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserStorageSessionGet(
    params: { key: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().storageSessionGet(
      params.key,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserStorageSessionSet(
    params: {
      key: string
      value: string
    } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().storageSessionSet(
      params.key,
      params.value,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserStorageSessionClear(params: BrowserCommandTargetParams): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().storageSessionClear(
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Download command ──

  async browserDownload(
    params: {
      selector: string
      path: string
    } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().download(
      params.selector,
      params.path,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Highlight command ──

  async browserHighlight(
    params: { selector: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().highlight(
      params.selector,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── New: exec passthrough + tab lifecycle ──

  async browserExec(params: { command: string } & BrowserCommandTargetParams): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().exec(
      params.command,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserTabCreate(params: {
    url?: string
    worktree?: string
    profileId?: string
  }): Promise<{ browserPageId: string }> {
    const url = params.url ?? 'about:blank'
    const worktreeId = params.worktree
      ? (await this.host.resolveWorktreeSelector(params.worktree)).id
      : undefined
    if (!this.host.getAvailableAuthoritativeWindow()) {
      throw new BrowserError(
        'browser_error',
        'Browser tab creation requires a desktop renderer; headless orca serve does not support browser panes yet.'
      )
    }
    const { browserPageId } = await this.createBrowserTabInRenderer(
      url,
      worktreeId,
      params.profileId
    )

    // Why: the renderer creates the Zustand tab immediately, but the webview must
    // mount and fire dom-ready before registerGuest runs. Waiting here ensures the
    // tab is operable by subsequent CLI commands (snapshot, click, etc.).
    // If registration doesn't complete within timeout, return the ID anyway — the
    // tab exists in the UI but may not be ready for automation commands yet.
    try {
      await waitForTabRegistration(browserPageId)
    } catch {
      // Tab was created in the renderer but the webview hasn't finished mounting.
      // Return success since the tab exists; subsequent commands will fail with a
      // clear "tab not available" error if the webview never loads.
    }

    // Why: newly created tabs should be auto-activated so subsequent commands
    // (snapshot, click, goto) target the new tab without requiring an explicit
    // tab switch. Without this, the bridge's active tab still points at the
    // previously active tab and the new tab shows active: false in tab list.
    const bridge = this.requireAgentBrowserBridge()
    const wcId = bridge.getRegisteredTabs(worktreeId).get(browserPageId)
    if (wcId != null) {
      bridge.setActiveTab(wcId, worktreeId)
    }

    // Why: the renderer sets webview.src=url on mount, but agent-browser connects
    // via CDP after the webview loads about:blank. Without an explicit goto, the
    // page stays blank from agent-browser's perspective. Navigate via the bridge
    // so agent-browser's CDP session tracks the correct page state.
    if (url && url !== 'about:blank') {
      try {
        const result = await bridge.goto(url, worktreeId, browserPageId)
        this.notifyRendererNavigation(browserPageId, result.url, result.title)
      } catch {
        // Tab exists but navigation failed — caller can retry with explicit goto
      }
    }

    return { browserPageId }
  }

  async browserTabSetProfile(
    params: {
      profileId: string
    } & BrowserCommandTargetParams
  ): Promise<BrowserTabSetProfileResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    const browserPageId =
      target.browserPageId ?? this.requireAgentBrowserBridge().getActivePageId(target.worktreeId)
    if (!browserPageId) {
      throw new BrowserError('browser_no_tab', 'No browser tab open in this worktree')
    }
    // Why: 'default' is a synthetic id; fall back to the registry's default profile when not registered.
    const profile =
      browserSessionRegistry.getProfile(params.profileId) ??
      (params.profileId === 'default' ? browserSessionRegistry.getDefaultProfile() : null)
    if (!profile) {
      throw new BrowserError(
        'invalid_argument',
        `Browser profile ${params.profileId} was not found`
      )
    }

    // Why: short-circuit no-op switches so the renderer doesn't tear down and
    // remount the webview when the tab is already on the requested profile.
    const currentProfileId = browserManager.getSessionProfileIdForTab(browserPageId) ?? 'default'
    if (currentProfileId === profile.id) {
      return {
        browserPageId,
        profileId: profile.id,
        profileLabel: profile.label
      }
    }

    const win = this.host.getAuthoritativeWindow()
    const requestId = randomUUID()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ipcMain.removeListener('browser:tabSetProfileReply', handler)
        reject(new Error('Tab profile update timed out'))
      }, 10_000)

      const handler = (
        _event: Electron.IpcMainEvent,
        reply: { requestId: string; error?: string }
      ): void => {
        if (reply.requestId !== requestId) {
          return
        }
        clearTimeout(timer)
        ipcMain.removeListener('browser:tabSetProfileReply', handler)
        if (reply.error) {
          reject(new Error(reply.error))
        } else {
          resolve()
        }
      }
      ipcMain.on('browser:tabSetProfileReply', handler)
      win.webContents.send('browser:requestTabSetProfile', {
        requestId,
        browserPageId,
        profileId: profile.id
      })
    })

    // Why: the renderer destroys the old webview and remounts on the new
    // partition. Wait for the re-register so a follow-up tab list
    // --show-profile reads the updated sessionProfileId from BrowserManager
    // instead of stale data, and so subsequent CLI ops (snapshot, click, etc.)
    // hit a guest that's already attached.
    try {
      await waitForTabRegistration(browserPageId)
    } catch {
      // Best-effort: re-register won't fire if the worktree is hidden. The
      // store already reflects the new profile; downstream commands retry
      // once the pane re-mounts.
    }

    return {
      browserPageId,
      profileId: profile.id,
      profileLabel: profile.label
    }
  }

  async browserTabProfileShow(params: {
    page: string
    worktree?: string
  }): Promise<BrowserTabProfileShowResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    const tab = this.describeBrowserTab(params.page, worktreeId)
    return {
      browserPageId: tab.browserPageId,
      worktreeId: tab.worktreeId ?? null,
      profileId: tab.profileId ?? null,
      profileLabel: tab.profileLabel ?? null
    }
  }

  async browserTabProfileClone(
    params: {
      profileId: string
    } & BrowserCommandTargetParams
  ): Promise<BrowserTabProfileCloneResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    const sourceBrowserPageId =
      target.browserPageId ?? this.requireAgentBrowserBridge().getActivePageId(target.worktreeId)
    if (!sourceBrowserPageId) {
      throw new BrowserError('browser_no_tab', 'No browser tab open in this worktree')
    }
    const sourceTab = this.describeBrowserTab(sourceBrowserPageId, target.worktreeId)
    const profile = browserSessionRegistry.getProfile(params.profileId)
    if (!profile) {
      throw new BrowserError(
        'invalid_argument',
        `Browser profile ${params.profileId} was not found`
      )
    }
    const created = await this.createBrowserTabInRenderer(
      sourceTab.url,
      sourceTab.worktreeId ?? target.worktreeId,
      profile.id
    )
    // Why: parity with browserTabCreate. Wait for the cloned tab's webview to
    // register so the returned browserPageId is operable by the next CLI call.
    try {
      await waitForTabRegistration(created.browserPageId)
    } catch {
      // Best-effort: registration may not fire if the worktree is hidden.
    }
    return {
      browserPageId: created.browserPageId,
      sourceBrowserPageId,
      profileId: profile.id,
      profileLabel: profile.label
    }
  }

  async browserProfileList(): Promise<BrowserProfileListResult> {
    return { profiles: browserSessionRegistry.listProfiles() }
  }

  async browserProfileCreate(params: {
    label: string
    scope: 'isolated' | 'imported'
  }): Promise<BrowserProfileCreateResult> {
    return {
      profile: browserSessionRegistry.createProfile(params.scope, params.label)
    }
  }

  async browserProfileDelete(params: { profileId: string }): Promise<BrowserProfileDeleteResult> {
    return {
      deleted: await browserSessionRegistry.deleteProfile(params.profileId),
      profileId: params.profileId
    }
  }

  async browserProfileDetectBrowsers(): Promise<BrowserDetectProfilesResult> {
    return {
      // Why: clients only need display metadata for the picker; filesystem
      // paths and keychain identifiers stay on the runtime server.
      browsers: detectInstalledBrowsers().map((browser) => ({
        family: browser.family,
        label: browser.label,
        profiles: browser.profiles,
        selectedProfile: browser.selectedProfile
      }))
    }
  }

  async browserProfileImportFromBrowser(params: {
    profileId: string
    browserFamily: string
    browserProfile?: string
  }): Promise<BrowserProfileImportFromBrowserResult> {
    const profile = browserSessionRegistry.getProfile(params.profileId)
    if (!profile) {
      return { ok: false, reason: 'Session profile not found.' }
    }
    if (
      params.browserProfile &&
      (/[/\\]/.test(params.browserProfile) || params.browserProfile.includes('..'))
    ) {
      return { ok: false, reason: 'Invalid browser profile name.' }
    }

    const browsers = detectInstalledBrowsers()
    let browser = browsers.find((candidate) => candidate.family === params.browserFamily)
    if (!browser) {
      return { ok: false, reason: 'Browser not found on this system.' }
    }

    if (params.browserProfile && params.browserProfile !== browser.selectedProfile) {
      const reselected = selectBrowserProfile(browser, params.browserProfile)
      if (!reselected) {
        return {
          ok: false,
          reason: `No cookies database found for profile "${params.browserProfile}".`
        }
      }
      browser = reselected
    }

    const result = await importCookiesFromBrowser(browser, profile.partition)
    if (!result.ok) {
      return result
    }

    const profileName =
      browser.profiles.find((candidate) => candidate.directory === browser.selectedProfile)?.name ??
      browser.selectedProfile
    browserSessionRegistry.updateProfileSource(params.profileId, {
      browserFamily: browser.family,
      profileName,
      importedAt: Date.now()
    })
    return { ...result, profileId: params.profileId }
  }

  async browserProfileClearDefaultCookies(): Promise<BrowserProfileClearDefaultCookiesResult> {
    return { cleared: await browserSessionRegistry.clearDefaultSessionCookies() }
  }

  async browserTabClose(params: {
    index?: number
    page?: string
    worktree?: string
  }): Promise<{ closed: boolean }> {
    const bridge = this.requireAgentBrowserBridge()
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)

    let tabId: string | null = null
    if (typeof params.page === 'string' && params.page.length > 0) {
      if (!bridge.getRegisteredTabs(worktreeId).has(params.page)) {
        const scope = worktreeId ? ' in this worktree' : ''
        throw new BrowserError(
          'browser_tab_not_found',
          `Browser page ${params.page} was not found${scope}`
        )
      }
      tabId = params.page
    } else if (params.index !== undefined) {
      const tabs = bridge.getRegisteredTabs(worktreeId)
      const entries = [...tabs.entries()]
      if (params.index < 0 || params.index >= entries.length) {
        throw new Error(`Tab index ${params.index} out of range (0-${entries.length - 1})`)
      }
      tabId = entries[params.index][0]
    } else {
      // Why: try the bridge first (registered tabs with webviews), then fall back
      // to asking the renderer to close its active browser tab (handles cases where
      // the webview hasn't mounted yet, e.g. tab was just created).
      const tabs = bridge.getRegisteredTabs(worktreeId)
      const entries = [...tabs.entries()]
      const activeEntry = entries.find(([, wcId]) => wcId === bridge.getActiveWebContentsId())
      if (activeEntry) {
        tabId = activeEntry[0]
      }
    }

    const win = this.host.getAuthoritativeWindow()
    const requestId = randomUUID()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ipcMain.removeListener('browser:tabCloseReply', handler)
        reject(new Error('Tab close timed out'))
      }, 10_000)

      const handler = (
        _event: Electron.IpcMainEvent,
        reply: { requestId: string; error?: string }
      ): void => {
        if (reply.requestId !== requestId) {
          return
        }
        clearTimeout(timer)
        ipcMain.removeListener('browser:tabCloseReply', handler)
        if (reply.error) {
          reject(new Error(reply.error))
        } else {
          resolve()
        }
      }
      ipcMain.on('browser:tabCloseReply', handler)
      // Why: when main cannot resolve a concrete tab id itself (for example if a
      // browser workspace exists in the renderer before its guest mounts), the
      // renderer still needs the intended worktree scope. Otherwise it falls
      // back to the globally active browser tab and can close a tab in the
      // wrong worktree.
      win.webContents.send('browser:requestTabClose', { requestId, tabId, worktreeId })
    })

    return { closed: true }
  }

  private enrichBrowserTabInfo(
    tab: BrowserTabListResult['tabs'][number]
  ): BrowserTabListResult['tabs'][number] {
    const rawProfileId = browserManager.getSessionProfileIdForTab(tab.browserPageId)
    const profile =
      browserSessionRegistry.getProfile(rawProfileId ?? 'default') ??
      browserSessionRegistry.getDefaultProfile()
    return {
      ...tab,
      worktreeId: browserManager.getWorktreeIdForTab(tab.browserPageId) ?? null,
      profileId: profile.id,
      profileLabel: profile.label
    }
  }

  private describeBrowserTab(
    browserPageId: string,
    explicitWorktreeId?: string
  ): BrowserTabListResult['tabs'][number] {
    const worktreeId = explicitWorktreeId ?? browserManager.getWorktreeIdForTab(browserPageId)
    const tab = this.requireAgentBrowserBridge()
      .tabList(worktreeId)
      .tabs.find((entry) => entry.browserPageId === browserPageId)
    if (!tab) {
      const scope = worktreeId ? ' in this worktree' : ''
      throw new BrowserError(
        'browser_tab_not_found',
        `Browser page ${browserPageId} was not found${scope}`
      )
    }
    return this.enrichBrowserTabInfo(tab)
  }

  private async createBrowserTabInRenderer(
    url: string,
    worktreeId?: string,
    profileId?: string
  ): Promise<{ browserPageId: string }> {
    const win = this.host.getAuthoritativeWindow()
    const requestId = randomUUID()

    if (worktreeId) {
      await this.ensureBrowserWorktreeActive(worktreeId)
    }

    const browserPageId = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        ipcMain.removeListener('browser:tabCreateReply', handler)
        reject(new Error('Tab creation timed out'))
      }, 10_000)

      const handler = (
        _event: Electron.IpcMainEvent,
        reply: { requestId: string; browserPageId?: string; error?: string }
      ): void => {
        if (reply.requestId !== requestId) {
          return
        }
        clearTimeout(timer)
        ipcMain.removeListener('browser:tabCreateReply', handler)
        if (reply.error) {
          reject(new Error(reply.error))
        } else {
          resolve(reply.browserPageId!)
        }
      }
      ipcMain.on('browser:tabCreateReply', handler)
      win.webContents.send('browser:requestTabCreate', {
        requestId,
        url,
        worktreeId,
        sessionProfileId: profileId
      })
    })

    return { browserPageId }
  }
}
