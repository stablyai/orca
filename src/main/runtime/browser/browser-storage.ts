import type { BrowserCommandTargetParams } from './browser-command-contracts'
import type { RuntimeBrowserCommandTargets } from './browser-command-targets'

export class RuntimeBrowserStorage {
  constructor(
    private readonly targets: Pick<
      RuntimeBrowserCommandTargets,
      'requireAgentBrowserBridge' | 'resolveBrowserCommandTarget'
    >
  ) {}

  async browserClipboardRead(params: BrowserCommandTargetParams): Promise<unknown> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .clipboardRead(target.worktreeId, target.browserPageId)
  }

  async browserClipboardWrite(
    params: { text: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .clipboardWrite(params.text, target.worktreeId, target.browserPageId)
  }

  async browserStorageLocalGet(
    params: { key: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .storageLocalGet(params.key, target.worktreeId, target.browserPageId)
  }

  async browserStorageLocalSet(
    params: {
      key: string
      value: string
    } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .storageLocalSet(params.key, params.value, target.worktreeId, target.browserPageId)
  }

  async browserStorageLocalClear(params: BrowserCommandTargetParams): Promise<unknown> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .storageLocalClear(target.worktreeId, target.browserPageId)
  }

  async browserStorageSessionGet(
    params: { key: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .storageSessionGet(params.key, target.worktreeId, target.browserPageId)
  }

  async browserStorageSessionSet(
    params: {
      key: string
      value: string
    } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .storageSessionSet(params.key, params.value, target.worktreeId, target.browserPageId)
  }

  async browserStorageSessionClear(params: BrowserCommandTargetParams): Promise<unknown> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .storageSessionClear(target.worktreeId, target.browserPageId)
  }
}
