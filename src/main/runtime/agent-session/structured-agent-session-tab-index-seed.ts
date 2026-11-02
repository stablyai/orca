import type { Tab } from '../../../shared/tab-types'
import type { ChatTabChange } from './agent-session-tab-layout'
import { savedSessionId } from '../saved-structured-agent-session-restoration'

/** Match windowless saved tabs to the index: add legacy missing tabs and remove closed or moved leftovers only while both records exist. */
export function chatTabChangesMatchingIndex(
  savedTabsByWorktree: Record<string, readonly Tab[]>,
  restored: readonly ({ worktreeId: string } & Extract<ChatTabChange, { open: unknown }>)[],
  retired: (sessionId: string, worktreeId: string, tab: Tab) => boolean
): Map<string, ChatTabChange[]> {
  // Each workspace's list is this call's own and only grows, so a batch of K changes costs K.
  const changes = new Map<string, ChatTabChange[]>()
  const add = (worktreeId: string, change: ChatTabChange): void => {
    const bucket = changes.get(worktreeId)
    if (bucket) {
      bucket.push(change)
    } else {
      changes.set(worktreeId, [change])
    }
  }
  for (const { worktreeId, open } of restored) {
    add(worktreeId, { open })
  }
  for (const [worktreeId, tabs] of Object.entries(savedTabsByWorktree)) {
    for (const tab of tabs) {
      const sessionId = savedSessionId(tab)
      if (sessionId && retired(sessionId, worktreeId, tab)) {
        add(worktreeId, { close: sessionId, tabId: tab.id })
      }
    }
  }
  return changes
}
