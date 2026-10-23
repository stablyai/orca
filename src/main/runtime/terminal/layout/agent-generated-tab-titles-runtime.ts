import { OrcaRuntimeWithWorktreeSleepResumeRecording } from '../stop/worktree-sleep-resume-recording'
import { AgentGeneratedTabTitles, type GeneratedTitleTarget } from './agent-generated-tab-titles'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-ipc-payload'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import type { LayoutApplyReply } from '../../../../shared/workspace-layout/workspace-layout-command-types'
import type { WindowLayoutCommand } from '../../runtime-layout-apply'

export abstract class OrcaRuntimeWithAgentGeneratedTabTitles extends OrcaRuntimeWithWorktreeSleepResumeRecording {
  abstract applyLayoutCommand(command: WindowLayoutCommand): Promise<LayoutApplyReply>

  private readonly agentGeneratedTabTitles = new AgentGeneratedTabTitles({
    enabled: () => this.store?.getSettings?.()?.tabAutoGenerateTitle === true,
    targetOf: (row) => this.generatedTitleTargetOf(row),
    orchestrationByPaneKey: () => this.agentOrchestrationProjection.buildByPaneKey(),
    apply: (command) => this.applyLayoutCommand(command)
  })

  /** A layout-owner build's generated tab title from the hook status main accepted. */
  recordHookStatusTitle(row: AgentStatusIpcPayload): void {
    this.agentGeneratedTabTitles.noteStatus(row)
  }

  /** Resolves once every title from a status recorded so far is written. */
  hookStatusTitlesSettled(): Promise<void> {
    return this.agentGeneratedTabTitles.settled()
  }

  private generatedTitleTargetOf(row: AgentStatusIpcPayload): GeneratedTitleTarget | null {
    const tabId =
      parsePaneKey(row.paneKey)?.tabId ?? parseLegacyNumericPaneKey(row.paneKey)?.tabId ?? null
    const worktreeId = row.worktreeId ?? this.getTerminalWorktreeIdForPaneKey(row.paneKey)
    if (!tabId || !worktreeId) {
      return null
    }
    // Why: a paired server's tabs are that server's; its own main titles them.
    const hostId = this.getWorkspaceSessionHostIdsForTab(worktreeId, tabId)[0]
    if (!hostId || parseExecutionHostId(hostId)?.kind === 'runtime') {
      return null
    }
    const session = this.store?.getWorkspaceSession?.(hostId)
    const tab = session?.tabsByWorktree[worktreeId]?.find((candidate) => candidate.id === tabId)
    if (!tab) {
      return null
    }
    // A legacy tab-bar entry's id can differ from its terminal's, which the pane key names.
    const barId = session?.unifiedTabs?.[worktreeId]?.find(
      (entry) => entry.contentType === 'terminal' && entry.entityId === tabId
    )?.id
    return { workspace: worktreeId, tabId: barId ?? tabId, tab }
  }
}
