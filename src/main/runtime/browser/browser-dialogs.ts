import type { AgentBrowserBridge } from '../../browser/agent-browser-bridge'
import type { BrowserCommandTargetParams } from './browser-command-contracts'
import type { RuntimeBrowserCommandTargets } from './browser-command-targets'
/** Keep JSON results stable across CLI payload versions. */
export type BrowserDialogResult = { accepted: boolean }

type BrowserDialogTargets = Pick<RuntimeBrowserCommandTargets, 'resolveBrowserCommandTarget'> & {
  requireAgentBrowserBridge(): Pick<AgentBrowserBridge, 'dialogAccept' | 'dialogDismiss'>
}

export class RuntimeBrowserDialogs {
  constructor(private readonly targets: BrowserDialogTargets) {}

  async browserDialogAccept(
    params: { text?: string } & BrowserCommandTargetParams
  ): Promise<BrowserDialogResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    await this.targets
      .requireAgentBrowserBridge()
      .dialogAccept(params.text, target.worktreeId, target.browserPageId)
    return { accepted: true }
  }

  async browserDialogDismiss(params: BrowserCommandTargetParams): Promise<BrowserDialogResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    await this.targets
      .requireAgentBrowserBridge()
      .dialogDismiss(target.worktreeId, target.browserPageId)
    return { accepted: false }
  }
}
