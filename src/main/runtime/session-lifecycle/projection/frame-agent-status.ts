import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import {
  attestedLaunchConfig,
  type PtyLaunchFacts
} from '../../terminal/launch/attested-launch-config'

/** A pane's projected agent status as a session-tabs frame publishes it. The frame names its
 *  worktree on every agent: a restored row without a live PTY names none, and clients decide row
 *  ownership (and retraction) by worktree. The turn stamp and owner's launch fact travel on the tab. */
export function frameAgentStatus(
  projected: (AgentStatusEntry & { turnCompletedAt?: number }) | undefined,
  worktreeId: string,
  pty?: PtyLaunchFacts | null
): { agentStatus?: AgentStatusEntry; projectedTurnCompletedAt?: number; launchAttested?: boolean } {
  if (!projected) {
    return {}
  }
  const { turnCompletedAt, ...fields } = projected
  return {
    agentStatus: { ...fields, worktreeId },
    ...(pty ? { launchAttested: !!attestedLaunchConfig(pty, fields.agentType) } : {}),
    ...(turnCompletedAt !== undefined ? { projectedTurnCompletedAt: turnCompletedAt } : {})
  }
}
