import { savedSessionId } from './agent-session/lifecycle/saved-structured-agent-session-restoration'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { LayoutApplyReply } from '../../shared/workspace-layout/workspace-layout-command-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session/workspace-session-state-types'
import {
  chatTabCloseCommand,
  chatTabLayoutCommand,
  loadChatTabLayout,
  type ChatTabChange,
  type ChatTabLayoutCommand
} from './agent-session/agent-session-tab-layout'

const MAX_STALE_PLACEMENT_RETRIES = 3

export type QueuedChatTabChange = {
  worktreeId: string
  change: ChatTabChange
  eligible?: () => boolean
}
type QueuedTabClose = QueuedChatTabChange & { change: { close: string; tabId: string } }
const isTabClose = (queued: QueuedChatTabChange): queued is QueuedTabClose =>
  'close' in queued.change && !!queued.change.tabId

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
  const changeOne = async (queued: QueuedChatTabChange): Promise<void> => {
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
                      'open' in queued.change ? queued.change.open.sessionId : queued.change.close
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
  const closesNow = (batch: readonly QueuedTabClose[]) => {
    const { worktreeId } = batch[0]!
    const session = deps.sessionOf(worktreeId)
    const workspace = session
      ? loadChatTabLayout(deps.hostIdOf(worktreeId), session, worktreeId).loaded.layout.workspaces[
          worktreeId
        ]
      : undefined
    const closes = batch.filter((queued) => !queued.eligible || queued.eligible())
    return chatTabCloseCommand(
      workspace,
      worktreeId,
      closes.map((queued) => queued.change)
    )
  }
  const closeTogether = async (batch: readonly QueuedTabClose[]): Promise<boolean> => {
    try {
      const command = closesNow(batch)
      if (!command) {
        return true
      }
      const sessionOfTab = new Map(batch.map(({ change }) => [change.tabId, change.close]))
      const reply = await deps.apply(command, {
        admit: (partitions) =>
          JSON.stringify(closesNow(batch)) === JSON.stringify(command) &&
          (!partitions ||
            partitions.every((partition) => {
              const tabs = new Map(
                (partition.unifiedTabs?.[command.workspace] ?? []).map((tab) => [tab.id, tab])
              )
              return command.tabIds.every((tabId) => {
                const tab = tabs.get(tabId)
                return !!tab && savedSessionId(tab) === sessionOfTab.get(tabId)
              })
            }))
      })
      return reply.ok
    } catch (error) {
      console.warn('[agent-session-tabs] closing chat tabs together failed:', error)
      return false
    }
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
      for (let index = 0; index < changes.length;) {
        const batch: QueuedTabClose[] = []
        for (
          let next = changes[index];
          next && isTabClose(next);
          next = changes[index + batch.length]
        ) {
          if (next.worktreeId !== changes[index]!.worktreeId) {
            break
          }
          batch.push(next)
        }
        const run = batch.length > 1 ? batch : [changes[index]!]
        index += run.length
        // A workspace's adjacent closes share one layout read and write; refused, each goes alone.
        if (batch.length > 1 && (await closeTogether(batch))) {
          continue
        }
        for (const queued of run) {
          await changeOne(queued)
        }
      }
    })
    return queue
  }
  return Object.assign(enqueue, { pendingOpens: () => [...pending] })
}
