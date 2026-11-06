import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'

/** A pane's projected agent status as a session-tabs frame publishes it. The frame names its
 *  worktree on every agent: a restored row without a live PTY names none, and clients decide row
 *  ownership (and retraction) by worktree. The turn stamp travels on the tab, not the status. */
export function frameAgentStatus(
  projected: (AgentStatusEntry & { turnCompletedAt?: number }) | undefined,
  worktreeId: string
): { agentStatus?: AgentStatusEntry; projectedTurnCompletedAt?: number } {
  if (!projected) {
    return {}
  }
  const { turnCompletedAt, ...fields } = projected
  return {
    agentStatus: { ...fields, worktreeId },
    ...(turnCompletedAt !== undefined ? { projectedTurnCompletedAt: turnCompletedAt } : {})
  }
}
