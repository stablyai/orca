import { savedSessionId } from './lifecycle/saved-structured-agent-session-restoration'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { LayoutApplyReply } from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import {
  chatTabLayoutCommand,
  loadChatTabLayout,
  type ChatTabChange,
  type ChatTabLayoutCommand
} from './agent-session-tab-layout'

const MAX_STALE_PLACEMENT_RETRIES = 3

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
    run?: { admit: (partitions?: readonly WorkspaceSessionState[]) => boolean }
  ) => Promise<LayoutApplyReply>
}) {
  let queue: Promise<void> = Promise.resolve()
  const pending = new Set<QueuedChatTabChange>()
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
  const enqueue = (
    input: readonly QueuedChatTabChange[] | (() => readonly QueuedChatTabChange[])
  ) => {
    if (typeof input !== 'function') {
      for (const change of input) {
        if ('open' in change.change) {
          pending.add(change)
        }
      }
    }
    queue = queue.then(async () => {
      let changes: readonly QueuedChatTabChange[]
      try {
        changes = typeof input === 'function' ? input() : input
      } catch (error) {
        console.warn('[agent-session-tabs] reading chat tab changes failed:', error)
        return
      }
      for (const queued of changes) {
        try {
          let placementRetries = 0
          for (let step = 0; step < 2;) {
            if (queued.eligible && !queued.eligible()) {
              break
            }
            const command = commandNow(queued)
            let placementChanged = false
            const reply = command
              ? await deps.apply(command, {
                  admit: (partitions) => {
                    if (queued.eligible && !queued.eligible()) {
                      return false
                    }
                    const current = commandNow(queued)
                    if (JSON.stringify(current) !== JSON.stringify(command)) {
                      placementChanged =
                        command.type === 'openAgentSessionTab' &&
                        current?.type === command.type &&
                        current.workspace === command.workspace &&
                        current.tabId === command.tabId &&
                        current.sessionId === command.sessionId &&
                        current.agent === command.agent
                      return false
                    }
                    return (
                      command.type !== 'closeTabs' ||
                      !partitions ||
                      partitions.every((partition) => {
                        const tab = partition.unifiedTabs?.[queued.worktreeId]?.find(
                          (candidate) => candidate.id === command.tabIds[0]
                        )
                        const sessionId =
                          'open' in queued.change
                            ? queued.change.open.sessionId
                            : queued.change.close
                        return !!tab && savedSessionId(tab) === sessionId
                      })
                    )
                  }
                })
              : null
            if (
              placementChanged &&
              reply &&
              !reply.ok &&
              reply.code === 'tab_not_found' &&
              placementRetries < MAX_STALE_PLACEMENT_RETRIES
            ) {
              placementRetries++
              continue
            }
            if (command && reply && !reply.ok) {
              console.warn(`[agent-session-tabs] ${command.type} refused:`, reply.code)
            }
            if (!reply?.ok || !('open' in queued.change) || command?.type !== 'closeTabs') {
              break
            }
            step++
          }
        } catch (error) {
          console.warn('[agent-session-tabs] a chat tab change failed:', error)
        } finally {
          pending.delete(queued)
        }
      }
    })
    return queue
  }
  return Object.assign(enqueue, { pendingOpens: () => [...pending] })
}
