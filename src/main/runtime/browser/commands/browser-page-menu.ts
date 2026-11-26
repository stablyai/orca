import type { BrowserReadImageResult } from '../../../../shared/browser/runtime/runtime-browser-contracts'
import type { BrowserCommandTargetParams } from './browser-command-contracts'
import type { RuntimeBrowserCommandTargets } from './browser-command-targets'

/** What a streamed page's right-click menu does on the host that renders the page. */
export class RuntimeBrowserPageMenu {
  constructor(
    private readonly targets: Pick<
      RuntimeBrowserCommandTargets,
      'requireAgentBrowserBridge' | 'resolveBrowserCommandTarget'
    >
  ) {}

  async browserReplaceMisspelling(
    params: { word: string } & BrowserCommandTargetParams
  ): Promise<{ replaced: true }> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .replaceMisspelling(params.word, target.worktreeId, target.browserPageId)
  }

  async browserAddWordToDictionary(
    params: { word: string } & BrowserCommandTargetParams
  ): Promise<{ added: boolean }> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .addWordToDictionary(params.word, target.worktreeId, target.browserPageId)
  }

  async browserSaveImage(
    params: { url: string } & BrowserCommandTargetParams
  ): Promise<{ started: true }> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .saveImage(params.url, target.worktreeId, target.browserPageId)
  }

  async browserReadImage(
    params: { url: string; offset?: number } & BrowserCommandTargetParams
  ): Promise<BrowserReadImageResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .readImage(params.url, params.offset ?? 0, target.worktreeId, target.browserPageId)
  }
}
