import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import {
  maybeAutoRenameBranchOnFirstWork,
  type FirstWorkBranchRenameDeps
} from './first-work-branch-rename'

export function maybeAutoRenameWorkspaceOnFirstStructuredTurn(
  summary: AgentSessionStatusSummary,
  options: { replay: boolean },
  deps: FirstWorkBranchRenameDeps
): Promise<void> | undefined {
  if (summary.status !== 'working') {
    return
  }
  return maybeAutoRenameBranchOnFirstWork(
    {
      // Structured sessions use workspace identity rather than a terminal pane.
      paneKey: '',
      tabId: undefined,
      worktreeId: summary.workspaceId,
      state: 'working',
      prompt: summary.latestPrompt,
      assistantMessage: undefined,
      isReplay: options.replay
    },
    deps
  )
}
