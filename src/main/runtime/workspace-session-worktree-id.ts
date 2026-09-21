import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

export function canonicalizeTerminalSessionWorktreeId(
  session: WorkspaceSessionState,
  sourceWorktreeId: string,
  targetWorktreeId: string
): void {
  if (sourceWorktreeId === targetWorktreeId) {
    return
  }
  // Why presence and not `?? []`: an absent row means never initialized, an explicit empty one is
  // the closed-last-terminal tombstone. Writing `[]` for a source that had no row invents that
  // tombstone, and the workspace then never gets its initial terminal. Same guard the keyed maps
  // below already use.
  if (Object.hasOwn(session.tabsByWorktree, sourceWorktreeId)) {
    const tabs = session.tabsByWorktree[sourceWorktreeId] ?? []
    delete session.tabsByWorktree[sourceWorktreeId]
    session.tabsByWorktree[targetWorktreeId] = tabs.map((tab) => ({
      ...tab,
      worktreeId: targetWorktreeId
    }))
  }

  const groups = session.tabGroups?.[sourceWorktreeId]
  if (groups) {
    delete session.tabGroups![sourceWorktreeId]
    session.tabGroups![targetWorktreeId] = groups.map((group) => ({
      ...group,
      worktreeId: targetWorktreeId
    }))
  }
  for (const keyedState of [
    session.tabGroupLayouts,
    session.activeTabIdByWorktree,
    session.activeGroupIdByWorktree
  ]) {
    if (!keyedState || !Object.hasOwn(keyedState, sourceWorktreeId)) {
      continue
    }
    keyedState[targetWorktreeId] = keyedState[sourceWorktreeId] as never
    delete keyedState[sourceWorktreeId]
  }
}
