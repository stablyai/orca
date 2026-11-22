import type {
  BrowserBackResult,
  BrowserClickResult,
  BrowserGotoResult,
  BrowserReloadResult,
  BrowserStopResult
} from '../../../../shared/browser/runtime/runtime-browser-contracts'
import type { BrowserPageZoomDirection } from '../../../../shared/browser/site-settings/browser-page-zoom'
import type {
  BrowserPageSiteDisplay,
  BrowserSiteColorScheme
} from '../../../../shared/browser/site-settings/browser-site-display'
import type {
  BrowserCommandTargetParams,
  RuntimeBrowserCommandHost
} from './browser-command-contracts'
import type { RuntimeBrowserCommandTargets } from './browser-command-targets'

export class RuntimeBrowserNavigation {
  constructor(
    private readonly host: Pick<
      RuntimeBrowserCommandHost,
      'getAvailableAuthoritativeWindowId' | 'notifyHeadlessBrowserSessionTabsChanged'
    >,
    private readonly targets: Pick<
      RuntimeBrowserCommandTargets,
      'requireAgentBrowserBridge' | 'resolveBrowserCommandTarget' | 'notifyRendererNavigation'
    >
  ) {}

  async browserClick(
    params: { element: string } & BrowserCommandTargetParams
  ): Promise<BrowserClickResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    const bridge = this.targets.requireAgentBrowserBridge()
    const result = await bridge.click(params.element, target.worktreeId, target.browserPageId)
    // Publish click-driven navigation even for non-active pages.
    const page = bridge.getPageInfo(target.worktreeId, target.browserPageId)
    if (page) {
      this.targets.notifyRendererNavigation(page.browserPageId, page.url, page.title)
    }
    return result
  }

  async browserGoto(
    params: { url: string } & BrowserCommandTargetParams
  ): Promise<BrowserGotoResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    const bridge = this.targets.requireAgentBrowserBridge()
    const result = await bridge.goto(params.url, target.worktreeId, target.browserPageId)
    const pageId = bridge.getActivePageId(target.worktreeId, target.browserPageId)
    if (pageId) {
      this.targets.notifyRendererNavigation(pageId, result.url, result.title)
    }
    if (this.host.getAvailableAuthoritativeWindowId() === null && target.worktreeId) {
      this.host.notifyHeadlessBrowserSessionTabsChanged?.(target.worktreeId)
    }
    return result
  }

  async browserBack(params: BrowserCommandTargetParams): Promise<BrowserBackResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    const bridge = this.targets.requireAgentBrowserBridge()
    const result = await bridge.back(target.worktreeId, target.browserPageId)
    const pageId = bridge.getActivePageId(target.worktreeId, target.browserPageId)
    if (pageId) {
      this.targets.notifyRendererNavigation(pageId, result.url, result.title)
    }
    return result
  }

  async browserReload(
    params: BrowserCommandTargetParams & { ignoreCache?: boolean }
  ): Promise<BrowserReloadResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    const bridge = this.targets.requireAgentBrowserBridge()
    const result = await bridge.reload(target.worktreeId, target.browserPageId, {
      ignoreCache: params.ignoreCache === true
    })
    const pageId = bridge.getActivePageId(target.worktreeId, target.browserPageId)
    if (pageId) {
      this.targets.notifyRendererNavigation(pageId, result.url, result.title)
    }
    return result
  }

  async browserZoom(
    params: { direction: BrowserPageZoomDirection } & BrowserCommandTargetParams
  ): Promise<BrowserPageSiteDisplay | null> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .zoom(params.direction, target.worktreeId, target.browserPageId)
  }

  async browserSiteDisplay(
    params: BrowserCommandTargetParams
  ): Promise<BrowserPageSiteDisplay | null> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .siteDisplay(target.worktreeId, target.browserPageId)
  }

  async browserSetSiteColorScheme(
    params: { colorScheme: BrowserSiteColorScheme | null } & BrowserCommandTargetParams
  ): Promise<BrowserPageSiteDisplay | null> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .setSiteColorScheme(params.colorScheme, target.worktreeId, target.browserPageId)
  }

  async browserStop(params: BrowserCommandTargetParams): Promise<BrowserStopResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets.requireAgentBrowserBridge().stop(target.worktreeId, target.browserPageId)
  }

  async browserForward(params: BrowserCommandTargetParams): Promise<unknown> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets.requireAgentBrowserBridge().forward(target.worktreeId, target.browserPageId)
  }
}
