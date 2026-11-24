import { notifyWorktreeActivity } from '../../ipc/worktrees/git/worktree-activity-signal'
import { agentHookServer } from '../server/agent-hook-server'

/** A finished agent turn may have run git in its worktree; let that repo's metadata backstop re-check. */
export function installAgentTurnWorktreeActivity(): () => void {
  return agentHookServer.subscribeEnrichedStatus((event) => {
    if (
      event.payload.state !== 'done' ||
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
