import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import type { TuiAgent } from '../../shared/tui-agent'

export function resolveRequestedStartupAgent(
  args: RuntimeManagedWorktreeCreateArgs,
  disabledTuiAgents: readonly TuiAgent[]
): { requestedAgent: TuiAgent | undefined; requestedAgentEnabled: boolean } {
  const requestedAgent = args.startupAgent ?? args.createdWithAgent
  const requestedAgentEnabled =
    requestedAgent !== undefined ? isTuiAgentEnabled(requestedAgent, disabledTuiAgents) : false
  if ((args.startup || args.startupAgent) && requestedAgent && !requestedAgentEnabled) {
    throw new Error('Selected agent is disabled. Choose an enabled agent before creating.')
  }
  if (
    args.startup &&
    args.startupDraftPaste &&
    !isTuiAgentEnabled(args.startupDraftPaste.agent, disabledTuiAgents)
  ) {
    throw new Error('Selected agent is disabled. Choose an enabled agent before creating.')
  }
  return { requestedAgent, requestedAgentEnabled }
}
