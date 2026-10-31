import type { Tab } from '../../../shared/tab-types'
import type { ChatTabChange } from './agent-session-tab-layout'
import { savedSessionId } from '../saved-structured-agent-session-restoration'

/** Match windowless saved tabs to the index: add legacy missing tabs and remove closed leftovers only while both records exist. */
export function chatTabChangesMatchingIndex(
  savedTabsByWorktree: Record<string, readonly Tab[]>,
  restored: readonly ({ worktreeId: string } & Extract<ChatTabChange, { open: unknown }>)[],
  retired: (sessionId: string) => boolean
): Map<string, ChatTabChange[]> {
  const changes = new Map<string, ChatTabChange[]>()
  const add = (worktreeId: string, change: ChatTabChange): void => {
    changes.set(worktreeId, [...(changes.get(worktreeId) ?? []), change])
  }
  for (const { worktreeId, open } of restored) {
    add(worktreeId, { open })
  }
  for (const [worktreeId, tabs] of Object.entries(savedTabsByWorktree)) {
    for (const tab of tabs) {
      const sessionId = savedSessionId(tab)
      if (sessionId && retired(sessionId)) {
        add(worktreeId, { close: sessionId })
      }
    }
  }
  return changes
}
