/**
 * Projects kept as a distro's UNC path into a Windows drive (`\\wsl.localhost\<d>\mnt\c\x`), which
 * the mover refuses: D1c converts each in place to the same folder's drive path (`C:\x`) on this
 * computer. This is the scope and the path map; nothing here writes.
 */
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { resolveFolderWorkspaceHost } from '../../shared/folder-workspace-execution-host'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { Repo } from '../../shared/repo-types'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { rewriteWorktreeIdPath } from '../../shared/worktree/id'
import { wslUncPathToLinux } from '../../shared/wsl-paths'
import { wslMoveRepoPaths } from '../persistence/moving-wsl-projects/wsl-move-scope'

export type WslDriveUncRefusal =
  /** Some of its paths are inside the distro or elsewhere, so no single drive path holds it. */
  | 'mixed-locations'
  /** It already runs on another host. */
  | 'not-local'
  /** The drive path is already a project here; converting would make two rows for one folder. */
  | 'duplicate-windows-project'

export type WslDriveUncScope = {
  repoIds: string[]
  folderWorkspaceIds: string[]
  refused: { kind: 'repo' | 'folder-workspace'; id: string; reason: WslDriveUncRefusal }[]
}

type WslDriveUncScopeState = {
  repos: readonly Repo[]
  folderWorkspaces: readonly FolderWorkspace[]
  projectGroups: readonly ProjectGroup[]
}

/** `\\wsl.localhost\<distro>\mnt\c\x` → `C:\x`; null for any other path. */
export function wslUncDrivePathToWindows(path: string, distro: string): string | null {
  const linux = wslUncPathToLinux(path, distro)?.replace(/\\/g, '/')
  // Windows folds the `/mnt/<drive>` part of a UNC path case-insensitively.
  const match = linux?.match(/^\/mnt\/([a-z])(\/.*)?$/i)
  if (!match) {
    return null
  }
  const tail = (match[2] ?? '').replace(/\/+$/, '').replace(/\//g, '\\')
  return `${match[1].toUpperCase()}:${tail || '\\'}`
}

export function collectWslDriveUncScope(
  state: WslDriveUncScopeState,
  distro: string
): WslDriveUncScope {
  const scope: WslDriveUncScope = { repoIds: [], folderWorkspaceIds: [], refused: [] }
  const localDrivePaths = new Set(
    state.repos
      .filter((repo) => getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID)
      .map((repo) => normalizeRuntimePathForComparison(repo.path))
  )
  for (const repo of state.repos) {
    const target = wslUncDrivePathToWindows(repo.path, distro)
    if (!target) {
      continue
    }
    const reason =
      getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID
        ? 'not-local'
        : // A relative worktree base comes back joined onto the repo's UNC path.
          !wslMoveRepoPaths(repo).every((path) => wslUncDrivePathToWindows(path, distro))
          ? 'mixed-locations'
          : localDrivePaths.has(normalizeRuntimePathForComparison(target))
            ? 'duplicate-windows-project'
            : null
    if (reason) {
      scope.refused.push({ kind: 'repo', id: repo.id, reason })
    } else {
      scope.repoIds.push(repo.id)
    }
  }
  const hostState = { repos: [...state.repos], projectGroups: [...state.projectGroups] }
  for (const workspace of state.folderWorkspaces) {
    if (!wslUncDrivePathToWindows(workspace.folderPath, distro)) {
      continue
    }
    // This row alone: another host may hold a folder workspace with the same id.
    const local =
      resolveFolderWorkspaceHost({ ...hostState, folderWorkspaces: [workspace] }, workspace.id)
        .kind === 'local'
    if (local) {
      scope.folderWorkspaceIds.push(workspace.id)
    } else {
      scope.refused.push({ kind: 'folder-workspace', id: workspace.id, reason: 'not-local' })
    }
  }
  return scope
}

/** The worktree id a converted project's worktree gets: same repo id, drive path. */
export function wslDriveUncWorktreeId(worktreeId: string, distro: string): string {
  return rewriteWorktreeIdPath(worktreeId, (path) => wslUncDrivePathToWindows(path, distro) ?? path)
}
