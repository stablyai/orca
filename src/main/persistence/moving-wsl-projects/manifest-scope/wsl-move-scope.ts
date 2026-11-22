// Move local repos/folders only when every path stays in one distro outside Windows drive mounts.
import { posix } from 'node:path'
import { getRepoExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { resolveFolderWorkspaceHost } from '../../../../shared/folder-workspaces/folder-workspace-execution-host'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project/groups/project-group-types'
import type { Repo } from '../../../../shared/repository/repo-types'
import {
  isDrvfsLinuxPath,
  resolveWslRepoWorktreeBasePath
} from '../../../../shared/file-access/wsl-paths'
import {
  toWslDistroUncPath,
  wslMoveSourcePathToLinux,
  type WslMappedDrive
} from '../../../../shared/wsl-move/wsl-mapped-drive-paths'

export type WslMoveScopeRefusal =
  /** Distro access does not make Windows-drive projects Linux-owned. */
  | 'windows-drive'
  | 'mixed-locations'
  | 'not-local'
  /** Worktree records Git for Windows wrote: the host's Git can't follow their links. */
  | 'windows-git-worktrees'
  /** Its own `.git` file names a Windows path (a worktree or separate Git folder). */
  | 'windows-git-dir'
  /** Its Git records couldn't be read in time, so they couldn't be checked. */
  | 'git-unreadable'
  /** Windows didn't say where its drive letter points just now. */
  | 'mapped-drive-unverifiable'

/** What the move learned about mapped drives before scoping. */
export type WslMoveScopeDrives = {
  mappedDrives?: readonly WslMappedDrive[]
  /** Mapped-drive repos the host's Git can't take (wsl-move-windows-git-worktrees). */
  windowsGitRefusals?: ReadonlyMap<string, WslMoveScopeRefusal>
  /** Letters Windows didn't answer for that may map into this distro. */
  unverifiableLetters?: readonly string[]
}

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

export function collectWslMoveScope(
  state: WslMoveScopeState,
  distro: string,
  drives: WslMoveScopeDrives = {}
): WslMoveScope {
  const scope: WslMoveScope = { repoIds: [], folderWorkspaceIds: [], refused: [] }
  const mappedDrives = drives.mappedDrives ?? []
  const toLinux = (path: string): string | null =>
    wslMoveSourcePathToLinux(path, distro, mappedDrives)
  // Listed, not dropped: the drive may well map here, so the user should check it again.
  const unverifiable = (path: string): boolean =>
    drives.unverifiableLetters?.includes(/^([A-Za-z]):[\\/]/.exec(path)?.[1].toUpperCase() ?? '') ??
    false
  for (const repo of state.repos) {
    const paths = wslMoveMappedRepoPaths(repo, mappedDrives)
    const local = getRepoExecutionHostId(repo) === 'local'
    const git = drives.windowsGitRefusals?.get(repo.id)
    // Git's reason holds whatever the drive does now: it is what the user must fix.
    if (local && (git === 'windows-git-worktrees' || git === 'windows-git-dir')) {
      scope.refused.push({ kind: 'repo', id: repo.id, reason: git })
      continue
    }
    if (local && unverifiable(repo.path)) {
      scope.refused.push({ kind: 'repo', id: repo.id, reason: 'mapped-drive-unverifiable' })
      continue
    }
    // Partly in-distro repos must refuse visibly rather than disappear from the preview.
    if (!paths.some((path) => toLinux(path) !== null)) {
      continue
    }
    const reason = refusalFor(paths, toLinux, !local) ?? git ?? null
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
    // Isolate this row: other hosts may reuse the same folder ID.
    const remote =
      resolveFolderWorkspaceHost({ ...hostState, folderWorkspaces: [workspace] }, workspace.id)
        .kind !== 'local'
    if (toLinux(workspace.folderPath) === null && (remote || !unverifiable(workspace.folderPath))) {
      continue
    }
    const reason = unverifiable(workspace.folderPath)
      ? 'mapped-drive-unverifiable'
      : refusalFor([workspace.folderPath], toLinux, remote)
    if (reason) {
      scope.refused.push({ kind: 'folder-workspace', id: workspace.id, reason })
    } else {
      scope.folderWorkspaceIds.push(workspace.id)
    }
  }
  return scope
}

export function wslMoveRepoPaths(repo: Repo): string[] {
  return wslMoveMappedRepoPaths(repo, [])
}

/** Every folder a repo names; relative and Linux bases resolve against its share spelling. */
export function wslMoveMappedRepoPaths(
  repo: Repo,
  mappedDrives: readonly WslMappedDrive[]
): string[] {
  const repoPath = toWslDistroUncPath(repo.path, mappedDrives)
  const base = repo.worktreeBasePath
    ? resolveWslRepoWorktreeBasePath(repoPath, repo.worktreeBasePath)
    : undefined
  return [
    repo.path,
    // Resolve relative bases before checking distro ownership.
    ...(base ? [isRelative(base) ? posixJoinUnc(repoPath, base) : base] : []),
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
  toLinux: (path: string) => string | null,
  remote: boolean
): WslMoveScopeRefusal | null {
  if (remote) {
    return 'not-local'
  }
  const linuxPaths: string[] = []
  for (const path of paths) {
    const linux = toLinux(path)
    if (linux === null) {
      return 'mixed-locations'
    }
    linuxPaths.push(posix.normalize(linux.replace(/\\/g, '/')))
  }
  // Windows folds the /mnt/<drive> UNC tail case-insensitively.
  return linuxPaths.some((path) => isDrvfsLinuxPath(path.toLowerCase())) ? 'windows-drive' : null
}
