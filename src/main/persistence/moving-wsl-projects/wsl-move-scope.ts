// Move local repos/folders only when every path stays in one distro outside Windows drive mounts.
import { posix } from 'node:path'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import { resolveFolderWorkspaceHost } from '../../../shared/folder-workspace-execution-host'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Repo } from '../../../shared/repo-types'
import {
  isDrvfsLinuxPath,
  resolveWslRepoWorktreeBasePath,
  wslUncPathToLinux
} from '../../../shared/wsl-paths'

export type WslMoveScopeRefusal =
  /** Distro access does not make Windows-drive projects Linux-owned. */
  'windows-drive' | 'mixed-locations' | 'not-local'

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
    // Partly in-distro repos must refuse visibly rather than disappear from the preview.
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
    // Isolate this row: other hosts may reuse the same folder ID.
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

function repoPaths(repo: Repo): string[] {
  const base = repo.worktreeBasePath
    ? resolveWslRepoWorktreeBasePath(repo.path, repo.worktreeBasePath)
    : undefined
  return [
    repo.path,
    // Resolve relative bases before checking distro ownership.
    ...(base ? [isRelative(base) ? posixJoinUnc(repo.path, base) : base] : []),
    ...(repo.folderUpgradeGitRootPath ? [repo.folderUpgradeGitRootPath] : []),
    ...(repo.customWorktreeVisibilitySources ?? []).map((source) => source.rootPath),
    ...(repo.externalWorktreeInboxBaselinePaths ?? []),
    ...(repo.importedExternalWorktreePaths ?? [])
  ]
}

/** Drive-relative C:trees stays on Windows. */
function isRelative(path: string): boolean {
  return !/^(?:[A-Za-z]:|[\\/])/.test(path)
}

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
  // Windows folds the /mnt/<drive> UNC tail case-insensitively.
  return linuxPaths.some((path) => isDrvfsLinuxPath(path.toLowerCase())) ? 'windows-drive' : null
}
