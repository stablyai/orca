import { resolve } from 'node:path'
import type { Store } from '../persistence'
import { computeWorkspaceRoot, getWorktreePathSettings } from './worktree-logic'
import { getWorktreeMirrorDistro } from '../project-runtime-git-options'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import { getProjectGroupSubtreeIds } from '../../shared/project-groups'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { Repo } from '../../shared/repo-types'

type FolderScopeStore = Pick<Store, 'getRepos'> &
  Partial<Pick<Store, 'getProjectGroups' | 'getFolderWorkspaces'>>

export function getLocalRepos(store: Store) {
  // Why: SSH repo paths are remote-host paths; treating them as local roots could authorize unrelated local folders or probe SSH-only paths.
  return store.getRepos().filter((repo) => !repo.connectionId)
}

function getFolderScopeCandidateRepos(
  folderPath: string,
  projectGroupId: string,
  projectGroups: readonly ProjectGroup[],
  repos: readonly Repo[]
): Repo[] {
  const groupIds = getProjectGroupSubtreeIds(projectGroups, projectGroupId)
  return repos.filter(
    (repo) =>
      (typeof repo.projectGroupId === 'string' && groupIds.has(repo.projectGroupId)) ||
      isPathInsideOrEqual(folderPath, repo.path)
  )
}

function isRemoteOnlyFolderScope(
  folderPath: string,
  projectGroupId: string,
  connectionId: string | null | undefined,
  projectGroups: readonly ProjectGroup[],
  repos: readonly Repo[]
): boolean {
  if (connectionId) {
    return true
  }
  const candidates = getFolderScopeCandidateRepos(folderPath, projectGroupId, projectGroups, repos)
  return candidates.length > 0 && candidates.every((repo) => Boolean(repo.connectionId))
}

function getFolderWorkspaceConnectionId(
  workspace: FolderWorkspace,
  projectGroups: readonly ProjectGroup[]
): string | null {
  return (
    workspace.connectionId ??
    projectGroups.find((group) => group.id === workspace.projectGroupId)?.connectionId ??
    null
  )
}

function getLocalFolderScopeRoots(store: Store): string[] {
  const scopeStore = store as FolderScopeStore
  const repos = scopeStore.getRepos()
  // Why: many filesystem tests use narrow Store doubles; folder scopes are additive.
  const projectGroups = scopeStore.getProjectGroups?.() ?? []
  const roots: string[] = []
  for (const group of projectGroups) {
    if (
      group.parentPath &&
      !isRemoteOnlyFolderScope(group.parentPath, group.id, group.connectionId, projectGroups, repos)
    ) {
      roots.push(resolve(group.parentPath))
    }
  }
  for (const workspace of scopeStore.getFolderWorkspaces?.() ?? []) {
    if (
      !isRemoteOnlyFolderScope(
        workspace.folderPath,
        workspace.projectGroupId,
        getFolderWorkspaceConnectionId(workspace, projectGroups),
        projectGroups,
        repos
      )
    ) {
      roots.push(resolve(workspace.folderPath))
    }
  }
  return roots
}

export function getAllowedRoots(store: Store): string[] {
  const localRepos = getLocalRepos(store)
  const settings = store.getSettings()
  const roots = [
    ...localRepos.map((repo) => resolve(repo.path)),
    ...getLocalFolderScopeRoots(store)
  ]
  if (settings.workspaceDir) {
    if (localRepos.length === 0) {
      roots.push(resolve(settings.workspaceDir))
    } else {
      for (const repo of localRepos) {
        roots.push(
          resolve(
            computeWorkspaceRoot(
              repo.path,
              // Why enriched here too: placement has to agree with the create
              // flow, or renderer file access is denied for a worktree Orca
              // just put on the WSL side.
              getWorktreePathSettings(repo, settings, getWorktreeMirrorDistro(store, repo))
            )
          )
        )
      }
    }
  }
  return roots
}
