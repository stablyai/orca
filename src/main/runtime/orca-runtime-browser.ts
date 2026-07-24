/* eslint-disable max-lines -- Why: this file is a command adapter for one external surface, Agent Browser automation. It stays separate from OrcaRuntimeService so runtime state does not grow further while browser routing remains easy to scan in one place. */
import { randomUUID } from 'node:crypto'
import { ipcMain, webContents, type BrowserWindow } from 'electron'
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
  BrowserScreencastResult,
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
import type { BrowserCertificateProceedResult } from '../../shared/types'
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import type { BrowserBackend } from '../browser/browser-backend'
import { browserCertificateTrustController, browserManager } from '../browser/browser-manager'
import { BrowserError } from '../browser/cdp-bridge'
import {
  startBrowserScreencast,
  type BrowserScreencastSession
} from '../browser/browser-screencast-stream'
import { browserSessionRegistry } from '../browser/browser-session-registry'
import {
  detectInstalledBrowsers,
  importCookiesFromBrowser,
  selectBrowserProfile
} from '../browser/browser-cookie-import'
import { waitForTabRegistration, waitForWorktreeTabRegistration } from '../ipc/browser'

export type BrowserCommandTargetParams = {
  worktree?: string
  page?: string
}

type ResolvedBrowserCommandTarget = {
  worktreeId?: string
  browserPageId?: string
}

type ResolvedBrowserPageWebContents = {
  browserPageId: string
  webContents: Electron.WebContents
}

type BrowserScreencastParams = {
  format: 'jpeg' | 'png'
  quality?: number
  maxWidth?: number
  maxHeight?: number
  viewportWidth?: number
  viewportHeight?: number
  deviceScaleFactor?: number
  mobile?: boolean
  everyNthFrame?: number
  minFrameIntervalMs?: number
} & BrowserCommandTargetParams

type BrowserScreencastStartResult = {
  subscriptionId: string
  ready: Extract<BrowserScreencastResult, { type: 'ready' }>
  session: BrowserScreencastSession
}

type ActiveBrowserScreencastPage = {
  stop: () => void
  done: Promise<void>
}

function clampInteger(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  return Math.min(max, Math.max(min, Math.round(value)))
}

function clampOptionalInteger(
  value: number | undefined,
  min: number,
  max: number
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }
  return Math.min(max, Math.max(min, Math.round(value)))
}

function clampOptionalNumber(
  value: number | undefined,
  min: number,
  max: number
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }
  return Math.min(max, Math.max(min, value))
}

export type RuntimeBrowserCommandHost = {
  getAgentBrowserBridge(): AgentBrowserBridge | null
  resolveWorktreeSelector(selector: string): Promise<{ id: string }>
  getAuthoritativeWindow(): BrowserWindow
  getAvailableAuthoritativeWindow(): BrowserWindow | null
  // Why: headless serve backs pages with a main-process offscreen backend; null when the environment can't support offscreen browsing.
  getOffscreenBrowserBackend(): BrowserBackend | null
  // Why: the session-tab snapshot owns focus, so a headless create must mark itself active or paired clients snap back to a terminal.
  markHeadlessBrowserSessionTabActive?(
    worktreeId: string | undefined,
    browserPageId: string,
    targetGroupId?: string
  ): void
}

export class RuntimeBrowserCommands {
  private readonly activeScreencastPageIds = new Set<string>()
  private readonly activeScreencastsByPageId = new Map<string, ActiveBrowserScreencastPage>()
  private readonly stoppingScreencastPageIds = new Map<string, Promise<void>>()

  constructor(private readonly host: RuntimeBrowserCommandHost) {}

  private requireAgentBrowserBridge(): AgentBrowserBridge {
    const bridge = this.host.getAgentBrowserBridge()
    if (!bridge) {
      throw new BrowserError('browser_no_tab', 'No browser session is active')
    }
    return bridge
  }

  private hasLiveRegisteredBrowserTab(
    bridge: AgentBrowserBridge,
    worktreeId: string | undefined
  ): boolean {
    for (const [, webContentsId] of bridge.getRegisteredTabs(worktreeId)) {
      const guest = webContents.fromId(webContentsId)
      if (guest && !guest.isDestroyed()) {
        return true
      }
    }
    return false
  }

  private hasLiveRegisteredBrowserPage(
    bridge: AgentBrowserBridge,
    worktreeId: string | undefined,
    browserPageId: string
  ): boolean {
    const webContentsId = bridge.getRegisteredTabs(worktreeId).get(browserPageId)
    if (webContentsId == null) {
      return false
    }
    const guest = webContents.fromId(webContentsId)
    return Boolean(guest && !guest.isDestroyed())
  }

  // Why: the CLI sends selectors (e.g. "path:/...") but the bridge keys tabs by "repoId::path"; resolve to that store-compatible id.
  private async resolveBrowserWorktreeId(selector?: string): Promise<string | undefined> {
    if (!selector) {
      // Why: after restart, webviews mount only when the pane is visible; activate the view so persisted tabs become operable via registerGuest.
      const bridge = this.host.getAgentBrowserBridge()
      if (bridge && !this.hasLiveRegisteredBrowserTab(bridge, undefined)) {
        try {
          await this.ensureBrowserWorktreeActive(undefined)
        } catch {
          // Window may not exist yet (e.g. during startup or in tests)
        }
      }
      return undefined
    }

    const worktreeId = (await this.host.resolveWorktreeSelector(selector)).id
    // Why: explicit selectors are user intent, so resolution errors surface (not silently widen scope); only activation stays best-effort.
    const bridge = this.host.getAgentBrowserBridge()
    if (bridge && !this.hasLiveRegisteredBrowserTab(bridge, worktreeId)) {
      try {
        await this.ensureBrowserWorktreeActive(worktreeId)
      } catch {
        // Fall through with the validated worktree id so routing stays scoped to the caller's explicit selector.
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

    const worktreeId = params.worktree
      ? (await this.host.resolveWorktreeSelector(params.worktree)).id
      : undefined
    const bridge = this.host.getAgentBrowserBridge()
    if (bridge && !this.hasLiveRegisteredBrowserPage(bridge, worktreeId, browserPageId)) {
      try {
        await this.ensureBrowserPageActive(worktreeId, browserPageId)
      } catch {
        // Fall through with the explicit page target; downstream routing surfaces a clear "tab not found" error if wake fails.
      }
    }
    return {
      // Why: an explicit browserPageId is already a stable tab identity, so don't auto-resolve cwd worktree scoping on top of it.
      worktreeId,
      browserPageId
    }
  }

  private resolveBrowserPageWebContents(
    worktreeId: string | undefined,
    browserPageId: string | undefined
  ): ResolvedBrowserPageWebContents {
    const bridge = this.requireAgentBrowserBridge()
    const resolvedPageId = browserPageId ?? bridge.getActivePageId(worktreeId)
    if (!resolvedPageId) {
      throw new BrowserError('browser_no_tab', 'No browser tab open in this worktree')
    }
    const webContentsId = bridge.getRegisteredTabs(worktreeId).get(resolvedPageId)
    if (webContentsId == null) {
      const scope = worktreeId ? ' in this worktree' : ''
      throw new BrowserError(
        'browser_tab_not_found',
        `Browser page ${resolvedPageId} was not found${scope}`
      )
    }
    const guest = webContents.fromId(webContentsId)
    if (!guest || guest.isDestroyed()) {
      throw new BrowserError(
        'browser_tab_not_found',
        `Browser page ${resolvedPageId} is no longer available`
      )
    }
    return { browserPageId: resolvedPageId, webContents: guest }
  }

  // Why: background-mount the worktree via a hidden visibility lease so the webview guest can register without stealing the user's visible pane.
  private async ensureBrowserWorktreeActive(worktreeId: string | undefined): Promise<void> {
    const win = this.host.getAuthoritativeWindow()
    win.webContents.send('browser:activateView', worktreeId ? { worktreeId } : {})
    // Why: the pane is operable only after the webview mounts and calls registerGuest; wait on that IPC rather than a flaky fixed sleep.
    await waitForWorktreeTabRegistration(worktreeId)
  }

  private async ensureBrowserPageActive(
    worktreeId: string | undefined,
    browserPageId: string
  ): Promise<void> {
    const win = this.host.getAuthoritativeWindow()
    win.webContents.send(
      'browser:activateView',
      worktreeId ? { worktreeId, browserPageId } : { browserPageId }
    )
    await waitForTabRegistration(browserPageId)
  }

  // Why: helper-driven clicks can bypass Electron navigation events; push authoritative URL/title updates after automation.
  private notifyRendererNavigation(browserPageId: string, url: string, title: string): void {
    try {
      const win = this.host.getAuthoritativeWindow()
      win.webContents.send('browser:navigation-update', { browserPageId, url, title })
    } catch {
      // Window may not exist during shutdown
    }
  }

  // Why: carry worktreeId (not a global setActiveWorktree) so one agent's --focus can't steal the screen from another agent's parallel worktree.
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
    // Why: clicks can trigger navigation, so push the tab's live URL/title to the renderer even when automation targeted a non-active page.
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

  async browserScreencast(
    params: BrowserScreencastParams,
    stream: {
      sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => boolean | void
      emit?: (event: BrowserScreencastResult) => void
    }
  ): Promise<BrowserScreencastStartResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    const { browserPageId, webContents: guest } = this.resolveBrowserPageWebContents(
      target.worktreeId,
      target.browserPageId
    )
    let stopping = this.stoppingScreencastPageIds.get(browserPageId)
    if (stopping) {
      await stopping
    }
    let active = this.activeScreencastsByPageId.get(browserPageId)
    while (active) {
      // Why: CDP allows one Page.startScreencast per page, so a new subscriber takes over a stale/hidden client instead of erroring.
      active.stop()
      await active.done
      stopping = this.stoppingScreencastPageIds.get(browserPageId)
      if (stopping) {
        await stopping
      }
      active = this.activeScreencastsByPageId.get(browserPageId)
    }
    this.activeScreencastPageIds.add(browserPageId)
    const format = params.format
    const subscriptionId = `browser-screencast:${browserPageId}:${randomUUID()}`
    let session: BrowserScreencastSession | null = null
    let resolveActiveDone!: () => void
    const activeDone = new Promise<void>((resolve) => {
      resolveActiveDone = resolve
    })
    let cancelledBeforeStart = false
    const activeRecord: ActiveBrowserScreencastPage = {
      stop: () => {
        if (session) {
          session.stop()
          return
        }
        cancelledBeforeStart = true
      },
      done: activeDone
    }
    this.activeScreencastsByPageId.set(browserPageId, activeRecord)
    try {
      session = await startBrowserScreencast(guest, {
        format,
        quality: clampInteger(params.quality, 10, 100, 70),
        maxWidth: clampInteger(params.maxWidth, 320, 3840, 1440),
        maxHeight: clampInteger(params.maxHeight, 240, 2160, 1200),
        viewportWidth: clampOptionalInteger(params.viewportWidth, 320, 3840),
        viewportHeight: clampOptionalInteger(params.viewportHeight, 240, 2160),
        deviceScaleFactor: clampOptionalNumber(params.deviceScaleFactor, 1, 4),
        mobile: params.mobile === true,
        everyNthFrame: clampInteger(params.everyNthFrame, 1, 10, 2),
        minFrameIntervalMs: clampInteger(params.minFrameIntervalMs, 0, 1000, 0),
        onFrame: stream.sendBinary,
        onEvent: stream.emit,
        onError: (message) => stream.emit?.({ type: 'error', message })
      })
      if (cancelledBeforeStart) {
        session.stop()
        await session.done
        throw new BrowserError('browser_error', 'Browser screencast was cancelled.')
      }
    } catch (error) {
      this.activeScreencastPageIds.delete(browserPageId)
      if (this.activeScreencastsByPageId.get(browserPageId) === activeRecord) {
        this.activeScreencastsByPageId.delete(browserPageId)
      }
      resolveActiveDone()
      throw error
    }
    let stoppingPromise: Promise<void> | null = null
    const clearPageGate = (): void => {
      this.activeScreencastPageIds.delete(browserPageId)
      if (this.activeScreencastsByPageId.get(browserPageId) === activeRecord) {
        this.activeScreencastsByPageId.delete(browserPageId)
      }
      if (
        stoppingPromise &&
        this.stoppingScreencastPageIds.get(browserPageId) === stoppingPromise
      ) {
        this.stoppingScreencastPageIds.delete(browserPageId)
      }
      resolveActiveDone()
    }
    const markStopping = (): void => {
      if (stoppingPromise || !session) {
        return
      }
      // Why: mobile can unsubscribe and instantly resubscribe on rotation; new streams wait for CDP teardown instead of failing already-active.
      stoppingPromise = session.done.finally(clearPageGate)
      this.stoppingScreencastPageIds.set(browserPageId, stoppingPromise)
    }
    void session.done.finally(() => {
      clearPageGate()
    })

    try {
      return {
        subscriptionId,
        session: {
          done: session.done,
          stop: () => {
            markStopping()
            session?.stop()
          }
        },
        ready: {
          type: 'ready',
          subscriptionId,
          browserPageId,
          format,
          tab: this.describeBrowserTab(browserPageId, target.worktreeId)
        }
      }
    } catch (error) {
      markStopping()
      session.stop()
      throw error
    }
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

  async browserProceedCertificate(
    params: { challengeId: string } & BrowserCommandTargetParams
  ): Promise<BrowserCertificateProceedResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    if (!target.browserPageId) {
      return { ok: false, reason: 'missing' }
    }
    return browserCertificateTrustController.proceed(target.browserPageId, params.challengeId)
  }

  async browserTabShow(params: { page: string; worktree?: string }): Promise<BrowserTabShowResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return { tab: this.describeBrowserTab(params.page, target.worktreeId) }
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
      // Why: scope focus to the tab's owning worktree; the renderer never yanks the user across worktrees on this signal (see focusBrowserTabInWorktree).
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

  async browserMouseClick(
    params: {
      x: number
      y: number
      button?: string
      radius?: number
      modifiers?: ('cmd' | 'ctrl' | 'alt' | 'shift')[]
    } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().mouseClick(
      params.x,
      params.y,
      params.button,
      target.worktreeId,
      target.browserPageId,
      clampOptionalNumber(params.radius, 0, 64),
      params.modifiers
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
    waitForRegistration?: boolean
    activate?: boolean
    targetGroupId?: string
  }): Promise<{ browserPageId: string }> {
    const url = params.url ?? 'about:blank'
    const worktreeId = params.worktree
      ? (await this.host.resolveWorktreeSelector(params.worktree)).id
      : undefined
    const sessionPartition = browserSessionRegistry.resolveKnownPartition(params.profileId)
    if (!sessionPartition) {
      throw new BrowserError(
        'invalid_argument',
        `Browser profile ${params.profileId} was not found`
      )
    }
    // Why: headless serve has no renderer <webview>, so back the page with a main-process offscreen WebContents instead.
    if (!this.host.getAvailableAuthoritativeWindow()) {
      const offscreen = this.host.getOffscreenBrowserBackend()
      if (!offscreen) {
        throw new BrowserError('browser_error', 'This host does not support browser panes.')
      }
      return this.createBrowserTabOffscreen(
        offscreen,
        url,
        worktreeId,
        params.profileId,
        params.activate,
        params.targetGroupId
      )
    }
    const { browserPageId } = await this.createBrowserTabInRenderer(
      url,
      worktreeId,
      params.profileId,
      params.profileId ? sessionPartition : undefined,
      params.activate
    )

    // Why: the webview must mount and register before the tab is operable, so wait here (returning the ID anyway on timeout).
    if (params.waitForRegistration !== false) {
      try {
        await waitForTabRegistration(browserPageId)
      } catch {
        // Tab exists in the renderer even if the webview hasn't mounted; subsequent commands surface a clear error if it never loads.
      }
    }

    // Why: auto-activate the new tab so subsequent commands target it without an explicit switch.
    const bridge = this.requireAgentBrowserBridge()
    const wcId = bridge.getRegisteredTabs(worktreeId).get(browserPageId)
    if (wcId != null) {
      bridge.setActiveTab(wcId, worktreeId)
    }

    // Why: the webview loads about:blank first; route navigation through the bridge so its registered owner remains authoritative.
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

    // Why: short-circuit no-op switches so the renderer doesn't needlessly tear down and remount the webview.
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
        profileId: profile.id,
        sessionPartition: profile.partition
      })
    })

    // Why: profile change remounts the webview; wait for re-register so follow-up commands see the new profile and an attached guest.
    try {
      await waitForTabRegistration(browserPageId)
    } catch {
      // Best-effort: re-register won't fire while the worktree is hidden; downstream commands retry once the pane re-mounts.
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
    const target = await this.resolveBrowserCommandTarget(params)
    const tab = this.describeBrowserTab(params.page, target.worktreeId)
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
      profile.id,
      profile.partition
    )
    // Why: wait for the cloned tab's webview to register so the returned browserPageId is operable by the next CLI call.
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
      // Why: expose only display metadata; filesystem paths and keychain identifiers stay on the runtime server.
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
    const pageTarget =
      typeof params.page === 'string' && params.page.length > 0
        ? await this.resolveBrowserCommandTarget({ worktree: params.worktree, page: params.page })
        : null
    const worktreeId =
      pageTarget?.worktreeId ?? (await this.resolveBrowserWorktreeId(params.worktree))

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
      // Why: try the bridge first; fall back to the renderer for tabs whose webview hasn't mounted yet (e.g. just created).
      const tabs = bridge.getRegisteredTabs(worktreeId)
      const entries = [...tabs.entries()]
      const activeEntry = entries.find(([, wcId]) => wcId === bridge.getActiveWebContentsId())
      if (activeEntry) {
        tabId = activeEntry[0]
      }
    }

    // Why: headless serve has no renderer to ask, so destroy the offscreen page directly.
    const offscreen = this.host.getAvailableAuthoritativeWindow()
      ? null
      : this.host.getOffscreenBrowserBackend()
    if (offscreen) {
      // Why: resolve the active page for implicit close so we don't report success while closing nothing.
      const resolvedTabId = tabId ?? bridge.getActivePageId(worktreeId)
      if (!resolvedTabId) {
        return { closed: false }
      }
      await offscreen.closeTab(resolvedTabId)
      return { closed: true }
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
      // Why: pass worktreeId so the renderer scopes the close correctly instead of falling back to the globally active tab in the wrong worktree.
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

  // Why: headless serve path — the offscreen backend registers synchronously, so there is no webview-mount wait.
  private async createBrowserTabOffscreen(
    offscreen: BrowserBackend,
    url: string,
    worktreeId?: string,
    profileId?: string,
    activate?: boolean,
    targetGroupId?: string
  ): Promise<{ browserPageId: string }> {
    const { browserPageId } = await offscreen.createTab({ url, worktreeId, profileId })
    const bridge = this.host.getAgentBrowserBridge()
    const wcId = bridge?.getRegisteredTabs(worktreeId).get(browserPageId)
    if (bridge && wcId != null) {
      bridge.setActiveTab(wcId, worktreeId)
    }
    // Why: only user-initiated creates (activate:true) mark the tab active; agent/background creates must not yank a connected client to it.
    if (activate === true) {
      this.host.markHeadlessBrowserSessionTabActive?.(worktreeId, browserPageId, targetGroupId)
    }
    return { browserPageId }
  }

  private async createBrowserTabInRenderer(
    url: string,
    worktreeId: string | undefined,
    profileId: string | undefined,
    sessionPartition: string | undefined,
    activate?: boolean
  ): Promise<{ browserPageId: string }> {
    const win = this.host.getAuthoritativeWindow()
    const requestId = randomUUID()

    const browserPageId = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        ipcMain.removeListener('browser:tabCreateReply', handler)
        reject(new Error('Tab creation timed out'))
      }, 10_000)

      const handler = (
        event: Electron.IpcMainEvent,
        reply: { requestId: string; browserPageId?: string; error?: string }
      ): void => {
        if (event.sender !== win.webContents || reply.requestId !== requestId) {
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
        // Why: keep these undefined (not null) when no profile is chosen so the renderer still applies default-profile inheritance.
        sessionProfileId: profileId,
        sessionPartition,
        activate
      })
    })

    return { browserPageId }
  }
}
