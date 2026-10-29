import type { ExecutionHostId } from '../../shared/execution-host'
import type { LayoutApplyReply } from '../../shared/workspace-layout/workspace-layout-command-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  chatTabLayoutCommand,
  loadChatTabLayout,
  type ChatTabChange,
  type ChatTabLayoutCommand
} from './agent-session/agent-session-tab-layout'

export type QueuedChatTabChange = { worktreeId: string; change: ChatTabChange }

/** Serialize changes against the current layout so close follows open; log refusals and continue. */
export function createChatTabLayoutQueue(deps: {
  sessionOf: (worktreeId: string) => WorkspaceSessionState | null
  /** Called only with a saved session; unplaceable worktrees throw. */
  hostIdOf: (worktreeId: string) => ExecutionHostId
  apply: (command: ChatTabLayoutCommand) => Promise<LayoutApplyReply>
}): (changesNow: () => readonly QueuedChatTabChange[]) => void {
  let queue: Promise<void> = Promise.resolve()
  const commandNow = ({ worktreeId, change }: QueuedChatTabChange) => {
    const session = deps.sessionOf(worktreeId)
    if (!session) {
      return chatTabLayoutCommand(undefined, undefined, worktreeId, change)
    }
    const hostId = deps.hostIdOf(worktreeId)
    const { loaded, activeGroupId } = loadChatTabLayout(hostId, session, worktreeId)
    return chatTabLayoutCommand(
      loaded.layout.workspaces[worktreeId],
      activeGroupId,
      worktreeId,
      change
    )
  }
  return (changesNow) => {
    queue = queue.then(async () => {
      let changes: readonly QueuedChatTabChange[]
      try {
        changes = changesNow()
      } catch (error) {
        console.warn('[agent-session-tabs] reading chat tab changes failed:', error)
        return
      }
      for (const queued of changes) {
        try {
          const command = commandNow(queued)
          const reply = command ? await deps.apply(command) : null
          if (command && reply && !reply.ok) {
            console.warn(`[agent-session-tabs] ${command.type} refused:`, reply.code)
          }
        } catch (error) {
          console.warn('[agent-session-tabs] a chat tab change failed:', error)
        }
      }
    })
  }
}
