import type { TerminalLayoutSnapshot } from '../../shared/terminal-tab-types'
import { terminalLayoutNodeLeafIds } from '../../shared/native-chat-leaf-ownership'
import { resolveTerminalTabViewMode } from '../../shared/terminal-tab-view-mode'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { buildHeadlessSessionTabPropsPatch } from './headless-session-tab-props-patch'

/**
 * Gives each persisted chat with two or more panes and no owner the host's owner, or terminal when
 * no pane may own chat. Older records and ownerless paths left these; once repaired a record never
 * matches again, so this persists at most once per tab. `pickOwner` returns undefined while the
 * evidence is incomplete, which leaves that record for a later rebuild. Null when nothing changes.
 */
export function normalizeOwnerlessSplitChats(
  session: WorkspaceSessionState,
  worktreeId: string,
  pickOwner: (layout: TerminalLayoutSnapshot) => string | null | undefined
): WorkspaceSessionState | null {
  let next: WorkspaceSessionState | null = null
  for (const tab of session.tabsByWorktree[worktreeId] ?? []) {
    const layout = session.terminalLayoutsByTabId?.[tab.id]
    // Why: a present owner is never reassigned; one outside the tree already reads as terminal.
    if (!layout || layout.chatLeafId || terminalLayoutNodeLeafIds(layout.root).length < 2) {
      continue
    }
    const unified = session.unifiedTabs?.[worktreeId]?.find(
      (candidate) => candidate.contentType === 'terminal' && candidate.entityId === tab.id
    )
    if (resolveTerminalTabViewMode(unified, tab) !== 'chat') {
      continue
    }
    const owner = pickOwner(layout)
    if (owner === undefined) {
      continue
    }
    next =
      buildHeadlessSessionTabPropsPatch(
        next ?? session,
        worktreeId,
        tab.id,
        owner ? { viewMode: 'chat', chatLeafId: owner } : { viewMode: 'terminal', chatLeafId: null }
      ) ?? next
  }
  return next
}
