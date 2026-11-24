import {
  claimBrowserMemoryPage,
  retainBrowserMemoryPageForAgent,
  waitForBrowserPageReady
} from '../../../browser/guest-lifecycle/browser-page-memory'
import type { BrowserSnapshotOptions } from '../../../../shared/rpc-contract/browser/browser-observation-params'
import type { AgentBrowserBridge } from '../../../browser/agent-browser/agent-browser-bridge'
import { BrowserError } from '../../../browser/browser-error'
import { browserPopupPageWebContentsId } from '../../../browser/guest-lifecycle/popups/browser-popup-page-id'
import { liveBrowserGuest } from '../../../browser/guest-lifecycle/live-browser-guest'
import {
  hasLiveRegisteredBrowserPage,
  hasLiveRegisteredBrowserTab
} from './browser-live-registered-pages'
import {
  waitForTabFirstLoad,
  waitForTabRegistration,
  waitForWorktreeTabRegistration
} from '../../../ipc/browser/browser-tab-registration-wait'
import { whenBrowserMainWindowReady } from '../../../browser/guest-lifecycle/browser-main-window-readiness'
import type { BrowserSnapshotResult } from '../../../../shared/browser/runtime/runtime-browser-contracts'
import type {
  BrowserCommandTargetParams,
  BrowserAnswerAdmission,
  RuntimeBrowserCommandHost,
  ResolvedBrowserCommandTarget,
  ResolvedBrowserPageWebContents
} from './browser-command-contracts'
import { getRuntimeDesktopSurface } from '../../construction/runtime-desktop-surface'
import { wakeBrowserClientPage } from '../../../browser/client-pages/lifecycle/browser-client-page-memory-registry'

const MAIN_WINDOW_READY_WAIT_MS = 8_000

export class RuntimeBrowserCommandTargets {
  constructor(
    private readonly host: Pick<
      RuntimeBrowserCommandHost,
      | 'getAgentBrowserBridge'
      | 'resolveWorkspaceSelector'
      | 'getAuthoritativeWindowId'
      | 'retireRuntimeOwnedBrowserSessionTab'
      | 'serveBrowserTabs'
      | 'readBrowserTabBar'
    >
  ) {}

  async withPageOperation<T>(
    params: BrowserCommandTargetParams,
    execute: (
      params: BrowserCommandTargetParams,
      admitAnswer?: BrowserAnswerAdmission
    ) => Promise<T>,
    mode: 'ordinary' | 'recover' | 'answer' = 'ordinary'
  ): Promise<T> {
    const explicitRelease = params.page ? claimBrowserMemoryPage(params.page, 'operation') : null
    let release = explicitRelease
    try {
      const worktreeId = params.worktree
        ? (await this.host.resolveWorkspaceSelector(params.worktree)).id
        : undefined
      const bridge = this.host.getAgentBrowserBridge()
      if (
        params.page &&
        (bridge?.getRegisteredPageWebContentsId(params.page, worktreeId) !== undefined ||
          this.host
            .readBrowserTabBar?.(worktreeId)
            .some((entry) => entry.browserPageId === params.page))
      ) {
        retainBrowserMemoryPageForAgent(params.page)
      }
      if (mode === 'answer') {
        const admitAnswer: BrowserAnswerAdmission = (resolved) => {
          let target: ResolvedBrowserPageWebContents
          try {
            target = this.resolveBrowserPageWebContents(resolved.worktreeId, resolved.browserPageId)
          } catch {
            return resolved
          }
          release ??= claimBrowserMemoryPage(target.browserPageId, 'operation')
          retainBrowserMemoryPageForAgent(target.browserPageId)
          return { ...resolved, browserPageId: target.browserPageId }
        }
        return await execute(params, admitAnswer)
      }
      let browserPageId =
        params.page ??
        (bridge && this.coldRoutedPageId(bridge, worktreeId)) ??
        bridge?.getActivePageId(worktreeId)
      if (!browserPageId && bridge) {
        await this.resolveBrowserWorktreeId(params.worktree)
        browserPageId = bridge.getActivePageId(worktreeId) ?? undefined
      }
      if (!browserPageId) {
        return await execute(params)
      }
      release ??= claimBrowserMemoryPage(browserPageId, 'operation')
      await this.ensureBrowserPageActive(worktreeId, browserPageId)
      const target = this.resolveBrowserPageWebContents(worktreeId, browserPageId)
      retainBrowserMemoryPageForAgent(browserPageId)
      await waitForBrowserPageReady(browserPageId, target.webContents, mode === 'recover')
      return await execute(params)
    } finally {
      release?.()
    }
  }

  requireAgentBrowserBridge(): AgentBrowserBridge {
    const bridge = this.host.getAgentBrowserBridge()
    if (!bridge) {
      throw new BrowserError('browser_no_tab', 'No browser session is active')
    }
    return bridge
  }

  retireGhostBrowserSessionRow(worktreeId: string | undefined, browserPageId: string): boolean {
    // A freed or not-yet-restarted serve page is closed by its saved tab, even when only the page is named.
    const owner = worktreeId ?? this.host.serveBrowserTabs?.savedWorktreeOf(browserPageId)
    return (
      owner !== undefined &&
      this.host.retireRuntimeOwnedBrowserSessionTab?.(owner, browserPageId) === true
    )
  }

  // A freed routed page is still the target, so restore it rather than act on a live sibling.
  private coldRoutedPageId(
    bridge: AgentBrowserBridge,
    worktreeId: string | undefined
  ): string | undefined {
    const routedPageId = bridge.getRoutedPageId(worktreeId)
    const cold =
      routedPageId !== null &&
      bridge.getRegisteredPageWebContentsId(routedPageId) === undefined &&
      this.host.readBrowserTabBar?.(worktreeId).some((page) => page.browserPageId === routedPageId)
    return cold ? routedPageId : undefined
  }

  // Resolve CLI selectors to the repoId::path keys the bridge uses.
  async resolveBrowserWorktreeId(selector?: string): Promise<string | undefined> {
    if (!selector) {
      // Persisted webviews register only after mounting; wake them before use.
      const bridge = this.host.getAgentBrowserBridge()
      if (bridge && !hasLiveRegisteredBrowserTab(bridge, undefined)) {
        try {
          await this.ensureBrowserWorktreeActive(undefined)
        } catch {
          // Startup/tests may have no window.
        }
      }
      return undefined
    }

    const worktreeId = (await this.host.resolveWorkspaceSelector(selector)).id
    // Explicit selector failures must surface instead of widening scope; activation alone is best-effort.
    const bridge = this.host.getAgentBrowserBridge()
    if (bridge && !hasLiveRegisteredBrowserTab(bridge, worktreeId)) {
      try {
        await this.ensureBrowserWorktreeActive(worktreeId)
      } catch {}
    }
    return worktreeId
  }

  async resolveBrowserCommandTarget(
    params: BrowserCommandTargetParams,
    options: { waitForFirstLoad?: boolean; passive?: boolean } = {}
  ): Promise<ResolvedBrowserCommandTarget> {
    const browserPageId =
      typeof params.page === 'string' && params.page.length > 0 ? params.page : undefined
    if (!browserPageId && !options.passive) {
      return { worktreeId: await this.resolveBrowserWorktreeId(params.worktree) }
    }
    const worktreeId = params.worktree
      ? (await this.host.resolveWorkspaceSelector(params.worktree)).id
      : undefined
    const bridge = this.host.getAgentBrowserBridge()
    // Popups never register, so waking for a closed one only stalls; a passive lookup never wakes.
    if (
      browserPageId &&
      !options.passive &&
      bridge &&
      browserPopupPageWebContentsId(browserPageId) === null &&
      !hasLiveRegisteredBrowserPage(bridge, worktreeId, browserPageId)
    ) {
      try {
        await this.ensureBrowserPageActive(worktreeId, browserPageId, options)
      } catch {}
    }
    return {
      // Explicit page ids already provide stable scope; do not add cwd-derived worktree scope.
      worktreeId,
      browserPageId
    }
  }

  resolveBrowserPageWebContents(
    worktreeId: string | undefined,
    browserPageId: string | undefined
  ): ResolvedBrowserPageWebContents {
    const bridge = this.requireAgentBrowserBridge()
    const resolvedPageId = browserPageId ?? bridge.getActivePageId(worktreeId)
    if (!resolvedPageId) {
      throw new BrowserError('browser_no_tab', 'No browser tab open in this worktree')
    }
    const webContentsId = bridge.getRegisteredPageWebContentsId(resolvedPageId, worktreeId)
    if (webContentsId == null) {
      const scope = worktreeId ? ' in this worktree' : ''
      throw new BrowserError(
        'browser_tab_not_found',
        `Browser page ${resolvedPageId} was not found${scope}`
      )
    }
    const guest = liveBrowserGuest(webContentsId)
    if (!guest) {
      throw new BrowserError(
        'browser_tab_not_found',
        `Browser page ${resolvedPageId} is no longer available`
      )
    }
    return { browserPageId: resolvedPageId, webContents: guest }
  }

  // Mount under a hidden visibility lease so automation cannot steal the visible pane.
  private async ensureBrowserWorktreeActive(worktreeId: string | undefined): Promise<void> {
    if (await this.host.serveBrowserTabs?.start(worktreeId, undefined)) {
      return
    }
    // With no saved tab the window mounts nothing, so the wait could only time out (#20434).
    if (this.host.serveBrowserTabs?.hasStartable(worktreeId) === false) {
      return
    }
    await this.sendActivateView(worktreeId ? { worktreeId } : {})
    // Await registerGuest rather than guessing a fixed mount delay.
    await waitForWorktreeTabRegistration(worktreeId)
  }

  async ensureBrowserPageActive(
    worktreeId: string | undefined,
    browserPageId: string,
    options: { waitForFirstLoad?: boolean } = {}
  ): Promise<void> {
    const bridge = this.host.getAgentBrowserBridge()
    if (bridge && hasLiveRegisteredBrowserPage(bridge, worktreeId, browserPageId)) {
      return
    }
    // A This-device page Memory Saver freed is remade on use, e.g. a phone opening it through here.
    if (await wakeBrowserClientPage(browserPageId)) {
      return
    }
    const notFound = (): BrowserError =>
      new BrowserError(
        'browser_tab_not_found',
        `Browser page ${browserPageId} was not found${worktreeId ? ' in this worktree' : ''}`
      )
    if (
      browserPopupPageWebContentsId(browserPageId) !== null ||
      this.host
        .readBrowserTabBar?.(worktreeId)
        .some((page) => page.browserPageId === browserPageId) === false
    ) {
      throw notFound()
    }
    try {
      const startedSavedPage = await this.host.serveBrowserTabs?.start(worktreeId, browserPageId)
      if (!startedSavedPage) {
        await this.sendActivateView(worktreeId ? { worktreeId, browserPageId } : { browserPageId })
        await waitForTabRegistration(browserPageId)
      }
      // A switched-to tab or a woken serve page should read like one open all along; streaming panes must not wait.
      if (options.waitForFirstLoad ?? startedSavedPage === true) {
        await waitForTabFirstLoad(browserPageId)
      }
    } catch {
      throw notFound()
    }
  }

  // A reloaded renderer drops activateView until it has restored the tab to mount.
  private async sendActivateView(payload: {
    worktreeId?: string
    browserPageId?: string
  }): Promise<void> {
    const windowId = this.host.getAuthoritativeWindowId()
    await whenBrowserMainWindowReady(MAIN_WINDOW_READY_WAIT_MS)
    if (!getRuntimeDesktopSurface().sendToWindow(windowId, 'browser:activateView', payload)) {
      throw new Error('No renderer window available')
    }
  }

  // Best effort: with no window (shutdown/headless) there is no view to update.
  private notifyRenderer(channel: string, payload: unknown): void {
    try {
      getRuntimeDesktopSurface().sendToWindow(
        this.host.getAuthoritativeWindowId(),
        channel,
        payload
      )
    } catch {}
  }

  // Automation may bypass Electron navigation events; publish authoritative URL/title updates.
  notifyRendererNavigation(browserPageId: string, url: string, title: string): void {
    this.notifyRenderer('browser:navigation-update', { browserPageId, url, title })
  }

  // Scope --focus to its worktree so parallel agents cannot move each other's view.
  notifyRendererBrowserPaneFocus(worktreeId: string | undefined, browserPageId: string): void {
    this.notifyRenderer('browser:pane-focus', { worktreeId: worktreeId ?? null, browserPageId })
  }

  async browserSnapshot(
    params: BrowserSnapshotOptions & BrowserCommandTargetParams
  ): Promise<BrowserSnapshotResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().snapshot(
      target.worktreeId,
      target.browserPageId,
      params
    )
  }
}
