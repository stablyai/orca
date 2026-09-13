// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by characterization tests.
import { OrcaRuntimeWithPruneMobileSessionTabGroupLayout } from './orca-runtime-prune-mobile-session-tab-group-layout'
import { recognizeAgentProcess } from '../../shared/agent-process-recognition'
import type { TuiAgent } from '../../shared/tui-agent'
import { getTerminalState } from './terminal-wait-results'
import {
  classifyAgentTitle,
  classifyLatestAgentTitle,
  getLatestLeafTitle
} from './runtime-worktree-status-projection'

export class OrcaRuntimeWithGetTerminalRunningTuiAgent extends OrcaRuntimeWithPruneMobileSessionTabGroupLayout {
  async getTerminalRunningTuiAgent(handle: string): Promise<TuiAgent | null> {
    try {
      const livePty = this.getLivePtyForHandle(handle)
      const leaf = livePty
        ? this.getPrimaryLeafForPty(livePty.pty.ptyId)
        : this.getLiveLeafForHandle(handle).leaf
      const ptyId = livePty?.pty.ptyId ?? leaf?.ptyId
      const controller = this.ptyController
      if (
        !ptyId ||
        !controller ||
        (livePty && !livePty.pty.connected) ||
        (!livePty && getTerminalState(leaf!) !== 'running')
      ) {
        return null
      }
      const leafTitle = leaf ? getLatestLeafTitle(leaf, null) : null
      const leafTitleClassification = classifyAgentTitle(leafTitle)
      const managementTitleClassification = livePty
        ? classifyLatestAgentTitle({
            title: livePty.pty.managementTitle,
            updatedAt: livePty.pty.managementTitleAt
          })
        : 'neutral'
      const shouldSuppressClaudeForeground = livePty
        ? leafTitle !== null
          ? leafTitleClassification === 'management'
          : managementTitleClassification === 'management'
        : leafTitleClassification === 'management' ||
          (leafTitle === null &&
            classifyAgentTitle(this.tabs.get(leaf!.tabId)?.title?.trim() || null) === 'management')
      let recognized = recognizeAgentProcess(await controller.getForegroundProcess(ptyId))
      this.assertLiveTerminalHandleTargetsPty(handle, ptyId)
      if (controller !== this.ptyController) {
        return null
      }
      if (!recognized && controller.confirmForegroundProcess) {
        recognized = recognizeAgentProcess(await controller.confirmForegroundProcess(ptyId))
        this.assertLiveTerminalHandleTargetsPty(handle, ptyId)
      }
      if (controller !== this.ptyController || !recognized) {
        return null
      }
      if (shouldSuppressClaudeForeground && recognized.agent === 'claude') {
        return null
      }
      return recognized.agent
    } catch {
      return null
    }
  }
}
