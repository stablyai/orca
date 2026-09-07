import { resolve } from 'node:path'
import type { Store } from '../persistence'
import { computeWorkspaceRoot, getWorktreePathSettings } from './worktree-logic'
import {
  getWorktreeMirrorDistroForRuntime,
  resolveLocalProjectRuntimesForRepos
} from '../project-runtime-git-options'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import {
  buildProjectGroupChildIndex,
  collectProjectGroupSubtreeIds,
  type ProjectGroupChildIndex
} from '../../shared/project-groups'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { Repo } from '../../shared/repo-types'

type FolderScopeStore = Pick<Store, 'getRepos'> &
  Partial<Pick<Store, 'getProjectGroups' | 'getFolderWorkspaces'>>

// Why: SSH repo paths are remote-host paths; treating them as local roots could authorize unrelated local folders or probe SSH-only paths.
function filterLocalRepos(repos: readonly Repo[]): Repo[] {
  return repos.filter((repo) => !repo.connectionId)
}

export function getLocalRepos(store: Store) {
  return filterLocalRepos(store.getRepos())
}

function getFolderScopeCandidateRepos(
  folderPath: string,
  projectGroupId: string,
  childGroupIndex: ProjectGroupChildIndex,
  repos: readonly Repo[]
): Repo[] {
  const groupIds = collectProjectGroupSubtreeIds(childGroupIndex, projectGroupId)
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
  childGroupIndex: ProjectGroupChildIndex,
  repos: readonly Repo[]
): boolean {
  if (connectionId) {
    return true
  }
  const candidates = getFolderScopeCandidateRepos(
    folderPath,
    projectGroupId,
    childGroupIndex,
    repos
  )
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

function getLocalFolderScopeRoots(store: Store, repos: readonly Repo[]): string[] {
  const scopeStore = store as FolderScopeStore
  // Why: many filesystem tests use narrow Store doubles; folder scopes are additive.
  const projectGroups = scopeStore.getProjectGroups?.() ?? []
  const childGroupIndex = buildProjectGroupChildIndex(projectGroups)
  const roots: string[] = []
  for (const group of projectGroups) {
    if (
      group.parentPath &&
      !isRemoteOnlyFolderScope(
        group.parentPath,
        group.id,
        group.connectionId,
        childGroupIndex,
        repos
      )
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
        childGroupIndex,
        repos
      )
    ) {
      roots.push(resolve(workspace.folderPath))
    }
  }
  return roots
}

export function getAllowedRoots(store: Store): string[] {
  // Why one read: `getRepos` rehydrates every repo, and this runs twice per filesystem IPC.
  const repos = store.getRepos()
  const localRepos = filterLocalRepos(repos)
  const settings = store.getSettings()
  const roots = [
    ...localRepos.map((repo) => resolve(repo.path)),
    ...getLocalFolderScopeRoots(store, repos)
  ]
  if (settings.workspaceDir) {
    if (localRepos.length === 0) {
      roots.push(resolve(settings.workspaceDir))
    } else {
      const projectRuntimeByRepoId = resolveLocalProjectRuntimesForRepos(store, localRepos)
      for (const repo of localRepos) {
        roots.push(
          resolve(
            computeWorkspaceRoot(
              repo.path,
              // Why enriched here too: placement has to agree with the create
              // flow, or renderer file access is denied for a worktree Orca
              // just put on the WSL side.
              getWorktreePathSettings(
                repo,
                settings,
                getWorktreeMirrorDistroForRuntime(projectRuntimeByRepoId.get(repo.id))
              )
            )
          )
        )
      }
    }
  }
  return roots
}
