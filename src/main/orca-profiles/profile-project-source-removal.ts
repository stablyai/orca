import type { WorkspaceKey } from '../../shared/folder-workspace-types'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import {
  rebuildRepoBackedProjectState,
  type TransferProfileState
} from './profile-project-state-file'
import {
  removeRepoFromHostWorkspaceSessions,
  removeRepoFromWorkspaceSession
} from './profile-project-session-state'
import { isRepoWorktreeId, removeRepoWorktreeRecord } from './profile-project-worktree-identity'

/** Removes repository-owned sessions, lineage, and UI preferences from the source profile after transfer. */
export function removeSourceRepo(
  state: TransferProfileState,
  repoId: string
): TransferProfileState {
  const next: TransferProfileState = {
    ...state,
    repos: state.repos.filter((repo) => repo.id !== repoId),
    sparsePresetsByRepo: { ...state.sparsePresetsByRepo },
    retiredWorktreeNamesByRepo: { ...state.retiredWorktreeNamesByRepo },
    worktreeMeta: { ...state.worktreeMeta },
    worktreeLineageById: { ...state.worktreeLineageById },
    workspaceLineageByChildKey: { ...state.workspaceLineageByChildKey },
    workspaceSession: removeRepoFromWorkspaceSession(state.workspaceSession, repoId),
    workspaceSessionsByHostId: removeRepoFromHostWorkspaceSessions(
      state.workspaceSessionsByHostId,
      repoId
    ),
    ui: {
      ...state.ui,
      lastActiveRepoId: state.ui.lastActiveRepoId === repoId ? null : state.ui.lastActiveRepoId,
      lastActiveWorktreeId:
        state.ui.lastActiveWorktreeId && isRepoWorktreeId(repoId, state.ui.lastActiveWorktreeId)
          ? null
          : state.ui.lastActiveWorktreeId,
      filterRepoIds: state.ui.filterRepoIds?.filter((id) => id !== repoId) ?? [],
      explorerDisplayRootByWorktree: removeRepoWorktreeRecord(
        state.ui.explorerDisplayRootByWorktree,
        repoId
      ),
      showDotfilesByWorktree: removeRepoWorktreeRecord(state.ui.showDotfilesByWorktree, repoId)
    }
  }
  delete next.sparsePresetsByRepo[repoId]
  delete next.retiredWorktreeNamesByRepo?.[repoId]
  removeRepoWorktreeMetadata(next, repoId)
  return rebuildRepoBackedProjectState(next)
}

function removeRepoWorktreeMetadata(state: TransferProfileState, repoId: string): void {
  for (const key of Object.keys(state.worktreeMeta)) {
    if (isRepoWorktreeId(repoId, key)) {
      delete state.worktreeMeta[key]
    }
  }
  for (const [key, lineage] of Object.entries(state.worktreeLineageById)) {
    if (isRepoWorktreeId(repoId, key) || isRepoWorktreeId(repoId, lineage.parentWorktreeId)) {
      delete state.worktreeLineageById[key]
    }
  }
  for (const [key, lineage] of Object.entries(state.workspaceLineageByChildKey)) {
    const child = parseWorkspaceKey(key)
    const parent = parseWorkspaceKey(lineage.parentWorkspaceKey)
    if (
      (child?.type === 'worktree' && isRepoWorktreeId(repoId, child.worktreeId)) ||
      (parent?.type === 'worktree' && isRepoWorktreeId(repoId, parent.worktreeId))
    ) {
      delete state.workspaceLineageByChildKey[key as WorkspaceKey]
    }
  }
}
