import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

export function canonicalizeTerminalSessionWorktreeId(
  session: WorkspaceSessionState,
  sourceWorktreeId: string,
  targetWorktreeId: string
): void {
  if (sourceWorktreeId === targetWorktreeId) {
    return
  }
  const tabs = session.tabsByWorktree[sourceWorktreeId] ?? []
  delete session.tabsByWorktree[sourceWorktreeId]
  session.tabsByWorktree[targetWorktreeId] = tabs.map((tab) => ({
    ...tab,
    worktreeId: targetWorktreeId
  }))

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
