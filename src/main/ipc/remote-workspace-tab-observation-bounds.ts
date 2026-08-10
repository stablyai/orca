import type {
  RemoteWorkspaceObservedTab,
  RemoteWorkspaceObservedWorktree,
  RemoteWorkspaceTabObservation,
  RemoteWorkspaceTerminalTab
} from '../../shared/remote-workspace-types'

export const MAX_REMOTE_WORKSPACE_OBSERVED_WORKTREES_PER_TARGET = 2_048
export const MAX_REMOTE_WORKSPACE_OBSERVED_TABS_PER_TARGET = 4_096

export function remoteWorkspaceTabSlotKey(
  worktreeInstanceId: string,
  tab: RemoteWorkspaceTerminalTab
): string {
  return JSON.stringify([worktreeInstanceId, tab.id, tab.createdAt])
}

export function remoteWorkspaceObservedTabMap(
  worktree: RemoteWorkspaceObservedWorktree
): Map<string, RemoteWorkspaceObservedTab> {
  if (!worktree.worktreeInstanceId) {
    return new Map()
  }
  return new Map(
    worktree.tabs.map((tab) => [
      remoteWorkspaceTabSlotKey(worktree.worktreeInstanceId!, tab.tab),
      tab
    ])
  )
}

export function boundedRemoteWorkspaceObservedWorktrees(
  observation: RemoteWorkspaceTabObservation
): Map<string, RemoteWorkspaceObservedWorktree> | null {
  if (
    typeof observation.targetId !== 'string' ||
    !observation.targetId ||
    observation.targetId.length > 512 ||
    observation.hydrated !== true ||
    !Array.isArray(observation.worktrees) ||
    observation.worktrees.length > MAX_REMOTE_WORKSPACE_OBSERVED_WORKTREES_PER_TARGET
  ) {
    return null
  }
  const worktrees = new Map<string, RemoteWorkspaceObservedWorktree>()
  let tabCount = 0
  for (const worktree of observation.worktrees) {
    if (!worktree || typeof worktree !== 'object' || !Array.isArray(worktree.tabs)) {
      return null
    }
    tabCount += worktree.tabs.length
    if (
      tabCount > MAX_REMOTE_WORKSPACE_OBSERVED_TABS_PER_TARGET ||
      typeof worktree.worktreeId !== 'string' ||
      !worktree.worktreeId ||
      worktree.worktreeId.length > 4_096 ||
      typeof worktree.worktreePath !== 'string' ||
      !worktree.worktreePath ||
      worktree.worktreePath.length > 4_096 ||
      (worktree.worktreeInstanceId !== null && typeof worktree.worktreeInstanceId !== 'string') ||
      worktree.worktreeInstanceId?.length === 0 ||
      (worktree.worktreeInstanceId?.length ?? 0) > 256 ||
      worktrees.has(worktree.worktreeId) ||
      worktree.tabs.some(
        (entry) =>
          !entry ||
          typeof entry !== 'object' ||
          !entry.tab ||
          typeof entry.tab !== 'object' ||
          typeof entry.tab.id !== 'string' ||
          !entry.tab.id ||
          entry.tab.id.length > 512 ||
          typeof entry.processIdentity !== 'string' ||
          entry.processIdentity.length > 4_096
      )
    ) {
      return null
    }
    worktrees.set(worktree.worktreeId, worktree)
  }
  return worktrees
}
