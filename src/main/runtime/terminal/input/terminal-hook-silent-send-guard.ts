import { selectLatestAgentStatusRow } from '../../workspaces/process-listing/runtime-hook-agent-row-selection'
import { agentHidesApprovalsFromHooks } from '../../../../shared/agent-status/approval/hook-silent-approval-agents'
import { recognizeAgentProcess } from '../../../../shared/agent-status/process/agent-process-recognition'
import { resolveTerminalTitleAgentType } from '../../../../shared/agent-status/title/terminal-title-agent-type'
import { OrcaRuntimeWithSerializeAgentPromptSubmission } from './terminal-agent-status-and-submission'

export abstract class OrcaRuntimeWithHookSilentSendGuard extends OrcaRuntimeWithSerializeAgentPromptSubmission {
  /** An agent whose hooks hide approvals may be in one unless its own latest report ended the turn; no report proves nothing. */
  async isTerminalAgentApprovalUnseen(handle: string): Promise<boolean> {
    const ptyId = this.getTerminalAgentStatusPtyId(handle)
    const foreground = await this.readPtyForegroundProcessFromController(ptyId)
    // A wrapper such as node can hide the agent until discovery settles; its title still names it.
    const agent =
      recognizeAgentProcess(foreground?.process)?.agent ??
      this.getPaneTerminalAgent(ptyId) ??
      resolveTerminalTitleAgentType(this.getTerminalAgentStatusSnapshot(handle, ptyId).title ?? '')
    const paneKey = this.getPaneKeyForTerminalHandle(handle)
    const row = selectLatestAgentStatusRow({
      handles: new Set([handle, ...this.getExistingTerminalHandlesForPtyId(ptyId)]),
      paneKey,
      hookRows: paneKey ? (this.publicPaneStatusFn?.(paneKey) ?? []) : []
    })
    // A row another agent left on this pane says nothing about the one running now.
    if (row && (agent === null || row.agentType === agent)) {
      return row.state !== 'done' && agentHidesApprovalsFromHooks(row.agentType)
    }
    return agentHidesApprovalsFromHooks(agent)
  }
}
