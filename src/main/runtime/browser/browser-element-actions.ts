import type {
  BrowserFillResult,
  BrowserScrollResult,
  BrowserSelectResult,
  BrowserTypeResult,
  BrowserCheckResult,
  BrowserDragResult,
  BrowserFocusResult,
  BrowserHoverResult,
  BrowserUploadResult,
  BrowserWaitResult,
  BrowserClearResult,
  BrowserKeypressResult,
  BrowserSelectAllResult
} from '../../../shared/runtime-types'
import type { BrowserCommandTargetParams } from './browser-command-contracts'
import type { RuntimeBrowserCommandTargets } from './browser-command-targets'

export class RuntimeBrowserElementActions {
  constructor(
    private readonly targets: Pick<
      RuntimeBrowserCommandTargets,
      'requireAgentBrowserBridge' | 'resolveBrowserCommandTarget'
    >
  ) {}

  async browserFill(
    params: {
      element: string
      value: string
    } & BrowserCommandTargetParams
  ): Promise<BrowserFillResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .fill(params.element, params.value, target.worktreeId, target.browserPageId)
  }

  async browserType(
    params: { input: string } & BrowserCommandTargetParams
  ): Promise<BrowserTypeResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .type(params.input, target.worktreeId, target.browserPageId)
  }

  async browserSelect(
    params: {
      element: string
      value: string
    } & BrowserCommandTargetParams
  ): Promise<BrowserSelectResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .select(params.element, params.value, target.worktreeId, target.browserPageId)
  }

  async browserScroll(
    params: { direction: 'up' | 'down'; amount?: number } & BrowserCommandTargetParams
  ): Promise<BrowserScrollResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .scroll(params.direction, params.amount, target.worktreeId, target.browserPageId)
  }

  async browserHover(
    params: { element: string } & BrowserCommandTargetParams
  ): Promise<BrowserHoverResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .hover(params.element, target.worktreeId, target.browserPageId)
  }

  async browserDrag(
    params: {
      from: string
      to: string
    } & BrowserCommandTargetParams
  ): Promise<BrowserDragResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .drag(params.from, params.to, target.worktreeId, target.browserPageId)
  }

  async browserUpload(
    params: { element: string; files: string[] } & BrowserCommandTargetParams
  ): Promise<BrowserUploadResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .upload(params.element, params.files, target.worktreeId, target.browserPageId)
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
    const target = await this.targets.resolveBrowserCommandTarget(params)
    const { worktree: _, page: __, ...options } = params
    return this.targets
      .requireAgentBrowserBridge()
      .wait(options, target.worktreeId, target.browserPageId)
  }

  async browserCheck(
    params: { element: string; checked: boolean } & BrowserCommandTargetParams
  ): Promise<BrowserCheckResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .check(params.element, params.checked, target.worktreeId, target.browserPageId)
  }

  async browserFocus(
    params: { element: string } & BrowserCommandTargetParams
  ): Promise<BrowserFocusResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .focus(params.element, target.worktreeId, target.browserPageId)
  }

  async browserClear(
    params: { element: string } & BrowserCommandTargetParams
  ): Promise<BrowserClearResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .clear(params.element, target.worktreeId, target.browserPageId)
  }

  async browserSelectAll(
    params: { element: string } & BrowserCommandTargetParams
  ): Promise<BrowserSelectAllResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .selectAll(params.element, target.worktreeId, target.browserPageId)
  }

  async browserKeypress(
    params: { key: string } & BrowserCommandTargetParams
  ): Promise<BrowserKeypressResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .keypress(params.key, target.worktreeId, target.browserPageId)
  }

  async browserDblclick(
    params: { element: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .dblclick(params.element, target.worktreeId, target.browserPageId)
  }

  async browserScrollIntoView(
    params: { element: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .scrollIntoView(params.element, target.worktreeId, target.browserPageId)
  }

  async browserGet(
    params: {
      what: string
      selector?: string
    } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .get(params.what, params.selector, target.worktreeId, target.browserPageId)
  }

  async browserIs(
    params: { what: string; selector: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .is(params.what, params.selector, target.worktreeId, target.browserPageId)
  }

  async browserFind(
    params: {
      locator: string
      value: string
      action: string
      text?: string
    } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .find(
        params.locator,
        params.value,
        params.action,
        params.text,
        target.worktreeId,
        target.browserPageId
      )
  }

  async browserHighlight(
    params: { selector: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .highlight(params.selector, target.worktreeId, target.browserPageId)
  }

  async browserExec(params: { command: string } & BrowserCommandTargetParams): Promise<unknown> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .exec(params.command, target.worktreeId, target.browserPageId)
  }
}
