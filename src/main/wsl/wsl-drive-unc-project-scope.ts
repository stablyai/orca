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
import { wslUncDrivePathToWindows } from '../../shared/wsl-paths'

export { wslUncDrivePathToWindows }
import { wslMoveRepoPaths } from '../persistence/moving-wsl-projects/wsl-move-scope'
import type { WindowsDriveMount } from '../runtime/wsl-guest-drive-mountinfo'
import { wslUncPathIsWindowsDriveFolder } from './wsl-drive-unc-mounts'

export type WslDriveUncRefusal =
  /** Some of its paths are inside the distro or elsewhere, so no single drive path holds it. */
  | 'mixed-locations'
  /** It already runs on another host. */
  | 'not-local'
  /** The drive path is already a project here, or another UNC spelling of it converts too. */
  | 'duplicate-windows-project'
  /** The distro's `/mnt/<letter>` folder is not that Windows drive, so the drive path is another folder. */
  | 'not-windows-drive-mount'
  /** A folder of it nests with one of a refused project, whose paths would then be split. */
  | 'overlaps-refused-project'

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

export function collectWslDriveUncScope(
  state: WslDriveUncScopeState,
  distro: string,
  /** The distro's Windows-drive mounts (readWslDistroDriveMounts); none refuses every path. */
  mounts: readonly WindowsDriveMount[]
): WslDriveUncScope {
  const scope: WslDriveUncScope = { repoIds: [], folderWorkspaceIds: [], refused: [] }
  const onDriveMount = (path: string): boolean => {
    const target = wslUncDrivePathToWindows(path, distro)
    return target !== null && wslUncPathIsWindowsDriveFolder(path, distro, target, mounts)
  }
  // Drive paths already taken; each accepted conversion claims its own, so a second spelling of
  // the same folder (`\\wsl$` vs `\\wsl.localhost`, `\mnt\C` vs `\mnt\c`) is a duplicate.
  const claimedRepoPaths = new Set(
    state.repos
      .filter((repo) => getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID)
      .map((repo) => normalizeRuntimePathForComparison(repo.path))
  )
  for (const repo of state.repos) {
    const target = wslUncDrivePathToWindows(repo.path, distro)
    if (!target) {
      continue
    }
    const key = normalizeRuntimePathForComparison(target)
    const paths = wslMoveRepoPaths(repo)
    const reason =
      getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID
        ? 'not-local'
        : // A relative worktree base comes back joined onto the repo's UNC path.
          !paths.every((path) => wslUncDrivePathToWindows(path, distro))
          ? 'mixed-locations'
          : !paths.every(onDriveMount)
            ? 'not-windows-drive-mount'
            : claimedRepoPaths.has(key)
              ? 'duplicate-windows-project'
              : null
    if (reason) {
      scope.refused.push({ kind: 'repo', id: repo.id, reason })
    } else {
      claimedRepoPaths.add(key)
      scope.repoIds.push(repo.id)
    }
  }
  refuseOverlaps(scope, state.repos, distro)
  const hostState = { repos: [...state.repos], projectGroups: [...state.projectGroups] }
  // This row alone: another host may hold a folder workspace with the same id.
  const isLocal = (workspace: FolderWorkspace): boolean =>
    resolveFolderWorkspaceHost({ ...hostState, folderWorkspaces: [workspace] }, workspace.id)
      .kind === 'local'
  const claimedFolderPaths = new Set(
    state.folderWorkspaces
      .filter((workspace) => isLocal(workspace))
      .map((workspace) => normalizeRuntimePathForComparison(workspace.folderPath))
  )
  for (const workspace of state.folderWorkspaces) {
    const target = wslUncDrivePathToWindows(workspace.folderPath, distro)
    if (!target) {
      continue
    }
    const key = normalizeRuntimePathForComparison(target)
    // One path, so its mount check is the mixed-location check repos get.
    const reason = !isLocal(workspace)
      ? 'not-local'
      : !onDriveMount(workspace.folderPath)
        ? 'not-windows-drive-mount'
        : claimedFolderPaths.has(key)
          ? 'duplicate-windows-project'
          : null
    if (reason) {
      scope.refused.push({ kind: 'folder-workspace', id: workspace.id, reason })
    } else {
      claimedFolderPaths.add(key)
      scope.folderWorkspaceIds.push(workspace.id)
    }
  }
  return scope
}

/** A bare path is re-keyed by the folder it lies in, so nested projects must convert together. */
function refuseOverlaps(scope: WslDriveUncScope, repos: readonly Repo[], distro: string): void {
  // A duplicate's folder is the project it duplicates, so it never splits a converted folder.
  const refusedIds = new Set(
    scope.refused
      .filter((entry) => entry.reason !== 'duplicate-windows-project')
      .map((entry) => entry.id)
  )
  const comparable = (repo: Repo): string[] =>
    wslMoveRepoPaths(repo).flatMap((path) => {
      const drive = wslUncDrivePathToWindows(path, distro)
      return drive ? [normalizeRuntimePathForComparison(drive)] : []
    })
  const refusedRoots = repos.filter((repo) => refusedIds.has(repo.id)).flatMap(comparable)
  const nests = (left: string, right: string): boolean =>
    left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
  const overlapping = new Set(
    repos
      .filter((repo) => scope.repoIds.includes(repo.id))
      .filter((repo) =>
        comparable(repo).some((root) => refusedRoots.some((refused) => nests(root, refused)))
      )
      .map((repo) => repo.id)
  )
  scope.repoIds = scope.repoIds.filter((id) => !overlapping.has(id))
  for (const id of overlapping) {
    scope.refused.push({ kind: 'repo', id, reason: 'overlaps-refused-project' })
  }
}

/** The worktree id a converted project's worktree gets: same repo id, drive path. */
export function wslDriveUncWorktreeId(worktreeId: string, distro: string): string {
  return rewriteWorktreeIdPath(worktreeId, (path) => wslUncDrivePathToWindows(path, distro) ?? path)
}
