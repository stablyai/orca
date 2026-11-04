import type { AgentBrowserBridge } from '../../browser/agent-browser/agent-browser-bridge'
import type { BrowserDialogAnswer } from '../../browser/agent-browser/agent-browser-bridge-page-commands'
import type { BrowserCommandTargetParams } from './browser-command-contracts'
import type { RuntimeBrowserCommandTargets } from './browser-command-targets'

type BrowserDialogTargets = Pick<RuntimeBrowserCommandTargets, 'resolveBrowserCommandTarget'> & {
  requireAgentBrowserBridge(): Pick<AgentBrowserBridge, 'dialogAccept' | 'dialogDismiss'>
}

export class RuntimeBrowserDialogs {
  constructor(private readonly targets: BrowserDialogTargets) {}

  async browserDialogAccept(
    params: { text?: string } & BrowserCommandTargetParams
  ): Promise<BrowserDialogAnswer> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .dialogAccept(params.text, target.worktreeId, target.browserPageId)
  }

  async browserDialogDismiss(params: BrowserCommandTargetParams): Promise<BrowserDialogAnswer> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .dialogDismiss(target.worktreeId, target.browserPageId)
  }
}
