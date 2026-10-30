import type {
  BrowserBackResult,
  BrowserClickResult,
  BrowserGotoResult,
  BrowserReloadResult
} from '../../../shared/runtime-types'
import type {
  BrowserCommandTargetParams,
  RuntimeBrowserCommandHost
} from './browser-command-contracts'
import type { RuntimeBrowserCommandTargets } from './browser-command-targets'

export class RuntimeBrowserNavigation {
  constructor(
    private readonly host: Pick<
      RuntimeBrowserCommandHost,
      'getAvailableAuthoritativeWindow' | 'notifyHeadlessBrowserSessionTabsChanged'
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
    if (!this.host.getAvailableAuthoritativeWindow() && target.worktreeId) {
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

  async browserReload(params: BrowserCommandTargetParams): Promise<BrowserReloadResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    const bridge = this.targets.requireAgentBrowserBridge()
    const result = await bridge.reload(target.worktreeId, target.browserPageId)
    const pageId = bridge.getActivePageId(target.worktreeId, target.browserPageId)
    if (pageId) {
      this.targets.notifyRendererNavigation(pageId, result.url, result.title)
    }
    return result
  }

  async browserForward(params: BrowserCommandTargetParams): Promise<unknown> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets.requireAgentBrowserBridge().forward(target.worktreeId, target.browserPageId)
  }
}
