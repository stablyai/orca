import { selectLatestAgentStatusRow } from '../../workspaces/process-listing/runtime-hook-agent-row-selection'
import { hookSilentPaneSendState } from '../../../../shared/agent-status/approval/hook-silent-approval-agents'
import { recognizeAgentProcess } from '../../../../shared/agent-status/process/agent-process-recognition'
import { resolveTerminalTitleAgentType } from '../../../../shared/agent-status/title/terminal-title-agent-type'
import { OrcaRuntimeWithSerializeAgentPromptSubmission } from './terminal-agent-status-and-submission'

export abstract class OrcaRuntimeWithHookSilentSendGuard extends OrcaRuntimeWithSerializeAgentPromptSubmission {
  /** An agent whose hooks hide approvals may be in one unless its own latest report ended the turn; no report proves nothing. */
  async isTerminalAgentApprovalUnseen(handle: string): Promise<boolean> {
    const ptyId = this.getTerminalAgentStatusPtyId(handle)
    const foreground = await this.readPtyForegroundProcessFromController(ptyId)
    const paneKey = this.getPaneKeyForTerminalHandle(handle)
    const row = selectLatestAgentStatusRow({
      handles: new Set([handle, ...this.getExistingTerminalHandlesForPtyId(ptyId)]),
      paneKey,
      hookRows: this.publicPaneStatusFn?.(paneKey ?? '', handle) ?? []
    })
    // Every identity counts: launch identity can outlive its agent, and a wrapper such as node hides the foreground one.
    return (
      hookSilentPaneSendState(row, [
        recognizeAgentProcess(foreground?.process)?.agent,
        this.getPaneTerminalAgent(ptyId),
        resolveTerminalTitleAgentType(
          this.getTerminalAgentStatusSnapshot(handle, ptyId).title ?? ''
        )
      ]) === 'unproven'
    )
  }
}
