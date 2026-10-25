import { isAbsolute, resolve } from 'node:path'
import type { RuntimeStore } from '../runtime/runtime-store-contract'
import { computeWorkspaceRootWithin, getWorktreePathSettings } from './worktree-logic'
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
import { hasRemoteFilesystemOwner } from './remote-filesystem-owner'

type FolderScopeStore = Pick<RuntimeStore, 'getRepos'> &
  Partial<Pick<RuntimeStore, 'getProjectGroups' | 'getFolderWorkspaces'>>

function filterLocalRepos(repos: readonly Repo[]): Repo[] {
  return repos.filter((repo) => !hasRemoteFilesystemOwner(repo))
}

export function getLocalRepos(store: RuntimeStore) {
  return filterLocalRepos(store.getRepos())
}

function isRemoteOnlyFolderScope(
  folderPath: string,
  projectGroupId: string,
  hasRemoteOwner: boolean,
  childGroupIndex: ProjectGroupChildIndex,
  repos: readonly Repo[]
): boolean {
  if (hasRemoteOwner) {
    return true
  }
  const groupIds = collectProjectGroupSubtreeIds(childGroupIndex, projectGroupId)
  let hasRemoteCandidate = false
  for (const repo of repos) {
    if (
      (typeof repo.projectGroupId === 'string' && groupIds.has(repo.projectGroupId)) ||
      isPathInsideOrEqual(folderPath, repo.path)
    ) {
      // One local candidate settles the scope without scanning the remaining repositories.
      if (!hasRemoteFilesystemOwner(repo)) {
        return false
      }
      hasRemoteCandidate = true
    }
  }
  return hasRemoteCandidate
}

/** Authorization rejects either remote ownership field, even where dispatch lets a workspace-local pin override legacy group ownership. */
function hasRemoteFolderWorkspaceOwner(
  workspace: FolderWorkspace,
  projectGroups: readonly ProjectGroup[]
): boolean {
  const group = projectGroups.find((group) => group.id === workspace.projectGroupId)
  return hasRemoteFilesystemOwner({
    connectionId: workspace.connectionId ?? group?.connectionId,
    executionHostId: workspace.executionHostId ?? group?.executionHostId
  })
}

function getLocalFolderScopeRoots(store: RuntimeStore, repos: readonly Repo[]): string[] {
  const scopeStore = store as FolderScopeStore
  // Narrow RuntimeStore doubles may omit additive folder-scope methods.
  const projectGroups = scopeStore.getProjectGroups?.() ?? []
  const childGroupIndex = buildProjectGroupChildIndex(projectGroups)
  const roots: string[] = []
  for (const group of projectGroups) {
    if (
      group.parentPath &&
      !isRemoteOnlyFolderScope(
        group.parentPath,
        group.id,
        hasRemoteFilesystemOwner(group),
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
        hasRemoteFolderWorkspaceOwner(workspace, projectGroups),
        childGroupIndex,
        repos
      )
    ) {
      roots.push(resolve(workspace.folderPath))
    }
  }
  return roots
}

/** The single path implementation that both judges and resolves a local root. */
type HostPathResolver = {
  isAbsolute: (value: string) => boolean
  resolve: (value: string) => string
}

/** Pair host-native absolute checks and resolution: cross-flavor acceptance could anchor C:\ws under POSIX cwd and grant an unrelated tree. */
export function resolveUnanchoredWorkspaceRoot(
  workspaceDir: string,
  hostPath: HostPathResolver = { isAbsolute, resolve }
): string | null {
  return hostPath.isAbsolute(workspaceDir) ? hostPath.resolve(workspaceDir) : null
}

// A broken distro must not hold every file check; the probe keeps running past this and caches.
const ALLOWED_ROOT_WSL_HOME_DEADLINE_MS = 5_000

/** Async because a root mirrored into WSL needs the distro's home, and a synchronous probe blocks main. */
export async function getAllowedRoots(store: RuntimeStore): Promise<string[]> {
  // Rehydrate repos only once per authorization snapshot.
  const repos = store.getRepos()
  const localRepos = filterLocalRepos(repos)
  const settings = store.getSettings()
  const roots = [
    ...localRepos.map((repo) => resolve(repo.path)),
    ...getLocalFolderScopeRoots(store, repos)
  ]
  if (settings.workspaceDir) {
    if (localRepos.length === 0) {
      const unanchoredRoot = resolveUnanchoredWorkspaceRoot(settings.workspaceDir)
      if (unanchoredRoot) {
        roots.push(unanchoredRoot)
      }
    } else {
      const projectRuntimeByRepoId = resolveLocalProjectRuntimesForRepos(store, localRepos)
      const workspaceRoots = await Promise.all(
        localRepos.map((repo) =>
          computeWorkspaceRootWithin(
            repo.path,
            // Match creation placement, including WSL, so newly created worktrees remain authorized.
            getWorktreePathSettings(
              repo,
              settings,
              getWorktreeMirrorDistroForRuntime(projectRuntimeByRepoId.get(repo.id))
            ),
            ALLOWED_ROOT_WSL_HOME_DEADLINE_MS
          )
        )
      )
      roots.push(...workspaceRoots.map((root) => resolve(root)))
    }
  }
  return roots
}
