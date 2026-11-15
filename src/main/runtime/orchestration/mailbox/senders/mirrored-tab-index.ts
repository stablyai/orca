import { buildByIdIndex } from '../../../../../shared/first-row-by-id-index'
import type { MirroredTabs, MirroredTerminalTab } from './orchestration-sender-name'

/** One pass's reads of mirrored sessions and their tabs by id: each worktree's session is read,
 *  and its tabs indexed, at most once. */
export function mirroredTabIndex(
  sessionOf: (worktreeId: string) => MirroredTabs | null | undefined
): {
  session: (worktreeId: string) => MirroredTabs | null | undefined
  readTab: (worktreeId: string, tabId: string) => MirroredTerminalTab | undefined
} {
  const sessions = new Map<string, MirroredTabs | null | undefined>()
  const tabsByWorktree = new Map<string, Map<string, MirroredTerminalTab>>()
  const session = (worktreeId: string) => {
    if (!sessions.has(worktreeId)) {
      sessions.set(worktreeId, sessionOf(worktreeId))
    }
    return sessions.get(worktreeId)
  }
  return {
    session,
    readTab: (worktreeId, tabId) => {
      let tabs = tabsByWorktree.get(worktreeId)
      if (!tabs) {
        tabs = buildByIdIndex(session(worktreeId)?.tabsByWorktree?.[worktreeId] ?? [])
        tabsByWorktree.set(worktreeId, tabs)
      }
      return tabs.get(tabId)
    }
  }
}
