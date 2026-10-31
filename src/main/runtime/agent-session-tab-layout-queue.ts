import type { LayoutCommandRunOptions } from './runtime-layout-apply'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { LayoutApplyReply } from '../../shared/workspace-layout/workspace-layout-command-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  chatTabLayoutCommand,
  loadChatTabLayout,
  type ChatTabChange,
  type ChatTabLayoutCommand
} from './agent-session/agent-session-tab-layout'

export type QueuedChatTabChange = {
  worktreeId: string
  change: ChatTabChange
  eligible?: () => boolean
}

/** Serialize changes against the current layout so close follows open; log refusals and continue. */
export function createChatTabLayoutQueue(deps: {
  sessionOf: (worktreeId: string) => WorkspaceSessionState | null
  /** Called only with a saved session; unplaceable worktrees throw. */
  hostIdOf: (worktreeId: string) => ExecutionHostId
  apply: (
    command: ChatTabLayoutCommand,
    options?: LayoutCommandRunOptions
  ) => Promise<LayoutApplyReply>
}): (changesNow: () => readonly QueuedChatTabChange[], admit?: () => boolean) => Promise<boolean> {
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
  return (changesNow, admit) => {
    const result = queue.then(async () => {
      let applied = true
      let changes: readonly QueuedChatTabChange[]
      try {
        changes = changesNow()
      } catch (error) {
        console.warn('[agent-session-tabs] reading chat tab changes failed:', error)
        return false
      }
      for (const queued of changes) {
        try {
          if (queued.eligible && !queued.eligible()) {
            continue
          }
          const command = commandNow(queued)
          if (!command && admit && 'close' in queued.change) {
            applied = false
          }
          const reply = command ? await deps.apply(command, admit ? { admit } : undefined) : null
          if (command && reply && !reply.ok) {
            applied = false
            console.warn(`[agent-session-tabs] ${command.type} refused:`, reply.code)
          }
        } catch (error) {
          applied = false
          console.warn('[agent-session-tabs] a chat tab change failed:', error)
        }
      }
      return applied
    })
    queue = result.then(() => {})
    return result
  }
}
