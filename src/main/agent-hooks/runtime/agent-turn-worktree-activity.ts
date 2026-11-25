import { notifyWorktreeActivity } from '../../ipc/worktrees/git/worktree-activity-signal'
import { agentHookServer } from '../server/agent-hook-server'

/** Agent work (tool calls, finished turns) may run git in its worktree; that repo's backstop re-checks, at most every 30 s. */
export function installAgentTurnWorktreeActivity(): () => void {
  return agentHookServer.subscribeEnrichedStatus((event) => {
    if (
      event.isReplay ||
      event.restoredUnconfirmed ||
      event.programStatusOnly ||
      event.identityOnly ||
      event.providerSessionOnly
    ) {
      return
    }
    notifyWorktreeActivity(event.worktreeId)
  })
}
