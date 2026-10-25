// A profile saved before the store kept a tab index restores its chats from the profile's own tabs.
// Those chats are recorded once, all together: an index written part way would read as complete at
// the next launch and drop the rest. With an index present, every restored chat is already listed.

import type { StructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-host'
import type { Tab } from '../../../shared/tab-types'
import type { ChatTabChange } from './agent-session-tab-layout'
import { savedSessionId } from '../saved-structured-agent-session-restoration'

type TabIndexHost = Pick<
  StructuredAgentSessionHost,
  'getPersistedVisibleSessionTabIndex' | 'showSessionTabs'
>

/** Best-effort: the tabs publish either way, and an index still absent is seeded again next launch. */
export async function seedStructuredAgentSessionTabIndex(
  host: (Partial<TabIndexHost> & Pick<StructuredAgentSessionHost, 'deps'>) | null | undefined,
  targets: readonly string[],
  restored: readonly string[]
): Promise<void> {
  if (!host?.getPersistedVisibleSessionTabIndex || !host.showSessionTabs) {
    return
  }
  const index = host.getPersistedVisibleSessionTabIndex()
  const listed = new Set(index.present ? index.sessionIds : [])
  const opened = new Set(restored)
  // In the restore's own order, so the seeded tabs keep the order the profile gave them.
  const unlisted = [...new Set([...targets, ...restored])].filter(
    (sessionId) => opened.has(sessionId) && !listed.has(sessionId)
  )
  if (unlisted.length > 0) {
    await host.showSessionTabs(unlisted).catch((error: unknown) =>
      host.deps.logger.warn('recording restored chat tabs failed', {
        scope: 'tab-index-seed',
        sessionIds: unlisted,
        error
      })
    )
  }
}

/**
 * The changes, by worktree, that make a windowless host's saved chat tabs match the index once it is
 * seeded. A restored chat with no saved tab gets one: its layout predates saved chat tabs. A saved
 * tab the index omits outlived its close (the process died between the index commit and the layout
 * save, or an older build closed it) and goes; that holds only while both records exist.
 */
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
