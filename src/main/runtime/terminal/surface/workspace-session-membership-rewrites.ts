// What the Store's terminal-membership rebase changed beyond the session it was given, for writers that report their workspaces.

import { structuralValuesEqualIgnoringUndefined } from '../../../../shared/collections/structural-value-equality'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'

/** What a rebase changed beyond its input: worktrees whose records it rewrote, and terminal tabs whose pane incarnations it changed. `whole`: a change it can't place. */
export type MembershipRewrites = { worktreeIds: Set<string>; tabIds: Set<string>; whole: boolean }

const differs = (left: unknown, right: unknown): boolean =>
  left !== right && !structuralValuesEqualIgnoringUndefined(left, right)

export function collectMembershipRewrites(
  incoming: WorkspaceSessionState,
  next: WorkspaceSessionState,
  rebased: readonly { worktreeId: string; tabIds: readonly string[] }[],
  rewrites: MembershipRewrites
): void {
  for (const { worktreeId, tabIds } of rebased) {
    if (
      differs(next.tabsByWorktree[worktreeId], incoming.tabsByWorktree[worktreeId]) ||
      differs(next.unifiedTabs?.[worktreeId], incoming.unifiedTabs?.[worktreeId]) ||
      differs(next.tabGroups?.[worktreeId], incoming.tabGroups?.[worktreeId]) ||
      differs(next.tabGroupLayouts?.[worktreeId], incoming.tabGroupLayouts?.[worktreeId]) ||
      differs(
        next.activeTabIdByWorktree?.[worktreeId],
        incoming.activeTabIdByWorktree?.[worktreeId]
      ) ||
      tabIds.some((tabId) =>
        differs(next.terminalLayoutsByTabId[tabId], incoming.terminalLayoutsByTabId?.[tabId])
      )
    ) {
      rewrites.worktreeIds.add(worktreeId)
    }
  }
  const before = incoming.terminalPtyIncarnationsByPaneKey ?? {}
  const after = next.terminalPtyIncarnationsByPaneKey ?? {}
  for (const paneKey of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[paneKey] !== after[paneKey]) {
      rewrites.tabIds.add(paneKey.slice(0, Math.max(paneKey.lastIndexOf(':'), 0)))
    }
  }
}
