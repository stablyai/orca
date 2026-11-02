/**
 * Which local projects a move into a distro's host may take (mover design, section 1): a repo or
 * folder workspace on host `local` whose every path is a UNC path of that distro, never through a
 * Windows drive mount. Anything that touches the distro but breaks the rule is refused with a
 * reason, so the preview can say why instead of silently leaving it behind.
 */
import { posix } from 'node:path'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import { resolveFolderWorkspaceHost } from '../../../shared/folder-workspace-execution-host'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Repo } from '../../../shared/repo-types'
import { isDrvfsLinuxPath, resolveWslRepoWorktreeBasePath } from '../../../shared/wsl-paths'
import { wslUncPathToLinux } from './wsl-move-path-rewriter'

export type WslMoveScopeRefusal =
  /** Its folder sits on a Windows drive reached through the distro; it stays a Windows project. */
  | 'windows-drive'
  /** Some of its paths are in another distro or on Windows. */
  | 'mixed-locations'
  /** It already runs on another host. */
  | 'not-local'

export type WslMoveScope = {
  repoIds: string[]
  folderWorkspaceIds: string[]
  refused: { kind: 'repo' | 'folder-workspace'; id: string; reason: WslMoveScopeRefusal }[]
}

type WslMoveScopeState = {
  repos: readonly Repo[]
  folderWorkspaces: readonly FolderWorkspace[]
  projectGroups: readonly ProjectGroup[]
}

export function collectWslMoveScope(state: WslMoveScopeState, distro: string): WslMoveScope {
  const scope: WslMoveScope = { repoIds: [], folderWorkspaceIds: [], refused: [] }
  for (const repo of state.repos) {
    const paths = repoPaths(repo)
    // A repo outside the distro that keeps any path inside it is refused, not skipped.
    if (!paths.some((path) => wslUncPathToLinux(path, distro) !== null)) {
      continue
    }
    const reason = refusalFor(paths, distro, getRepoExecutionHostId(repo) !== 'local')
    if (reason) {
      scope.refused.push({ kind: 'repo', id: repo.id, reason })
    } else {
      scope.repoIds.push(repo.id)
    }
  }
  const hostState = {
    repos: [...state.repos],
    projectGroups: [...state.projectGroups]
  }
  for (const workspace of state.folderWorkspaces) {
    if (wslUncPathToLinux(workspace.folderPath, distro) === null) {
      continue
    }
    // This row alone: another host may hold a folder workspace with the same id.
    const remote =
      resolveFolderWorkspaceHost({ ...hostState, folderWorkspaces: [workspace] }, workspace.id)
        .kind !== 'local'
    const reason = refusalFor([workspace.folderPath], distro, remote)
    if (reason) {
      scope.refused.push({ kind: 'folder-workspace', id: workspace.id, reason })
    } else {
      scope.folderWorkspaceIds.push(workspace.id)
    }
  }
  return scope
}

/** Every absolute path a repo row keeps; each must stay in the distro after the move. */
function repoPaths(repo: Repo): string[] {
  const base = repo.worktreeBasePath
    ? resolveWslRepoWorktreeBasePath(repo.path, repo.worktreeBasePath)
    : undefined
  return [
    repo.path,
    // A relative base stays beside the repo; it is checked once resolved against it.
    ...(base ? [isRelative(base) ? posixJoinUnc(repo.path, base) : base] : []),
    ...(repo.folderUpgradeGitRootPath ? [repo.folderUpgradeGitRootPath] : []),
    ...(repo.customWorktreeVisibilitySources ?? []).map((source) => source.rootPath),
    ...(repo.externalWorktreeInboxBaselinePaths ?? []),
    ...(repo.importedExternalWorktreePaths ?? [])
  ]
}

/** `C:trees` is drive-relative, i.e. on Windows, not beside the repo. */
function isRelative(path: string): boolean {
  return !/^(?:[A-Za-z]:|[\\/])/.test(path)
}

/** `repoUnc` joined with a relative base, kept in UNC form so the distro check still applies. */
function posixJoinUnc(repoUnc: string, relative: string): string {
  return `${repoUnc.replace(/[\\/]+$/, '')}/${relative.replace(/\\/g, '/')}`
}

function refusalFor(
  paths: readonly string[],
  distro: string,
  remote: boolean
): WslMoveScopeRefusal | null {
  if (remote) {
    return 'not-local'
  }
  const linuxPaths: string[] = []
  for (const path of paths) {
    const linux = wslUncPathToLinux(path, distro)
    if (linux === null) {
      return 'mixed-locations'
    }
    linuxPaths.push(posix.normalize(linux.replace(/\\/g, '/')))
  }
  // Windows folds the `/mnt/<drive>` tail of a UNC path case-insensitively, so `\MNT\C` is drive C.
  return linuxPaths.some((path) => isDrvfsLinuxPath(path.toLowerCase())) ? 'windows-drive' : null
}
