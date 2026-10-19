import type { AgentBrowserBridge } from '../../browser/agent-browser-bridge'
import type { RuntimeBrowserScreencasts } from './browser-screencasts'
import { browserDialogSettledResult, type BrowserDialogResult } from '../browser-dialog-settlement'
import type { BrowserCommandTargetParams } from './browser-command-contracts'
import type { RuntimeBrowserCommandTargets } from './browser-command-targets'
type BrowserDialogTargets = Pick<RuntimeBrowserCommandTargets, 'resolveBrowserCommandTarget'> & {
  requireAgentBrowserBridge(): Pick<AgentBrowserBridge, 'dialogAccept' | 'dialogDismiss'>
}

export class RuntimeBrowserDialogs {
  constructor(
    private readonly targets: BrowserDialogTargets,
    private readonly screencasts: Pick<RuntimeBrowserScreencasts, 'settleDialog'>
  ) {}

  async browserDialogAccept(
    params: { text?: string } & BrowserCommandTargetParams
  ): Promise<BrowserDialogResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    if (!(await this.screencasts.settleDialog(target.browserPageId, true, params.text))) {
      await this.targets
        .requireAgentBrowserBridge()
        .dialogAccept(params.text, target.worktreeId, target.browserPageId)
    }
    return browserDialogSettledResult(true)
  }

  async browserDialogDismiss(params: BrowserCommandTargetParams): Promise<BrowserDialogResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    if (!(await this.screencasts.settleDialog(target.browserPageId, false))) {
      await this.targets
        .requireAgentBrowserBridge()
        .dialogDismiss(target.worktreeId, target.browserPageId)
    }
    return browserDialogSettledResult(false)
  }
}
