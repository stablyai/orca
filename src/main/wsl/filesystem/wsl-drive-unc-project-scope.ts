/**
 * Projects kept as a distro's UNC path into a Windows drive (`\\wsl.localhost\<d>\mnt\c\x`), which
 * the mover refuses: D1c converts each in place to the same folder's drive path (`C:\x`) on this
 * computer. This is the scope and the path map; nothing here writes.
 */
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../shared/execution-host/execution-host'
import { resolveFolderWorkspaceHost } from '../../../shared/folder-workspaces/folder-workspace-execution-host'
import type { FolderWorkspace } from '../../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project/groups/project-group-types'
import type { Repo } from '../../../shared/repository/repo-types'
import { normalizeRuntimePathForComparison } from '../../../shared/file-access/cross-platform-path'
import { rewriteWorktreeIdPath } from '../../../shared/worktree/id'
import { wslUncDrivePathToWindows } from '../../../shared/file-access/wsl-paths'

import { wslMoveRepoPaths } from '../../persistence/moving-wsl-projects/manifest-scope/wsl-move-scope'
import type { WindowsDriveMount } from './wsl-guest-drive-mountinfo'
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
  refuseOverlaps(scope, state, distro)
  return scope
}

/**
 * A bare path is re-keyed by the folder it lies in, so a project nesting with a refused one, repo
 * or folder workspace either way round, would rewrite its paths; it is refused too, transitively.
 */
function refuseOverlaps(
  scope: WslDriveUncScope,
  state: Pick<WslDriveUncScopeState, 'repos' | 'folderWorkspaces'>,
  distro: string
): void {
  const projects = [
    ...state.repos.map((repo) => ({
      kind: 'repo' as const,
      id: repo.id,
      roots: driveRoots(wslMoveRepoPaths(repo), distro)
    })),
    ...state.folderWorkspaces.map((workspace) => ({
      kind: 'folder-workspace' as const,
      id: workspace.id,
      roots: driveRoots([workspace.folderPath], distro)
    }))
  ]
  const accepted = (kind: 'repo' | 'folder-workspace'): string[] =>
    kind === 'repo' ? scope.repoIds : scope.folderWorkspaceIds
  for (let added = true; added;) {
    added = false
    // A same-folder duplicate is the project it duplicates; nested ones: wslDriveUncDuplicatesSplitBy.
    const refusedRoots = scope.refused
      .filter((entry) => entry.reason !== 'duplicate-windows-project')
      // An accepted id is another host's row refused under the same folder workspace id.
      .filter((entry) => !accepted(entry.kind).includes(entry.id))
      .flatMap((entry) =>
        projects.filter((project) => project.kind === entry.kind && project.id === entry.id)
      )
      .flatMap((project) => project.roots)
    for (const project of projects) {
      if (
        accepted(project.kind).includes(project.id) &&
        project.roots.some((root) => refusedRoots.some((refused) => nests(root, refused)))
      ) {
        if (project.kind === 'repo') {
          scope.repoIds = scope.repoIds.filter((id) => id !== project.id)
        } else {
          scope.folderWorkspaceIds = scope.folderWorkspaceIds.filter((id) => id !== project.id)
        }
        scope.refused.push({
          kind: project.kind,
          id: project.id,
          reason: 'overlaps-refused-project'
        })
        added = true
      }
    }
  }
}

/** The picked projects and every convertible one nesting with them, which must convert together. */
export function withNestedWslDriveUncProjects(
  scope: WslDriveUncScope,
  distro: string,
  picked: { repoIds: readonly string[]; folderWorkspaceIds: readonly string[] },
  /** The folders a conversion of just this project rewrites, its saved worktrees included. */
  rewriteRoots: (project: { repoIds: string[]; folderWorkspaceIds: string[] }) => string[]
): { repoIds: string[]; folderWorkspaceIds: string[] } {
  const repoIds = new Set(picked.repoIds)
  const folderWorkspaceIds = new Set(picked.folderWorkspaceIds)
  const candidates = [
    ...scope.repoIds.map((id) => ({
      ids: repoIds,
      id,
      roots: driveRoots(rewriteRoots({ repoIds: [id], folderWorkspaceIds: [] }), distro)
    })),
    ...scope.folderWorkspaceIds.map((id) => ({
      ids: folderWorkspaceIds,
      id,
      roots: driveRoots(rewriteRoots({ repoIds: [], folderWorkspaceIds: [id] }), distro)
    }))
  ]
  for (let added = true; added;) {
    added = false
    const roots = candidates
      .filter((entry) => entry.ids.has(entry.id))
      .flatMap((entry) => entry.roots)
    for (const entry of candidates) {
      if (
        !entry.ids.has(entry.id) &&
        entry.roots.some((root) => roots.some((other) => nests(root, other)))
      ) {
        entry.ids.add(entry.id)
        added = true
      }
    }
  }
  return { repoIds: [...repoIds], folderWorkspaceIds: [...folderWorkspaceIds] }
}

/**
 * Refused duplicates a conversion rewriting these folders would split: their paths inside them
 * would move while their ids stay. A second spelling of a converting project is that project.
 */
export function wslDriveUncDuplicatesSplitBy(
  state: WslDriveUncScopeState,
  scope: WslDriveUncScope,
  distro: string,
  converting: { repoIds: readonly string[]; folderWorkspaceIds: readonly string[] },
  rewriteRoots: () => readonly string[]
): string[] {
  const duplicates = scope.refused.filter((entry) => entry.reason === 'duplicate-windows-project')
  if (duplicates.length === 0) {
    return []
  }
  const convertingFolders = new Set(
    driveRoots(
      [
        ...state.repos.filter(({ id }) => converting.repoIds.includes(id)).map(({ path }) => path),
        ...state.folderWorkspaces
          .filter(({ id }) => converting.folderWorkspaceIds.includes(id))
          .map(({ folderPath }) => folderPath)
      ],
      distro
    )
  )
  const roots = driveRoots(rewriteRoots(), distro)
  const splits = (folder: string, paths: readonly string[]): boolean =>
    !driveRoots([folder], distro).some((path) => convertingFolders.has(path)) &&
    driveRoots(paths, distro).some((path) => roots.some((root) => isInside(path, root)))
  return duplicates.flatMap(({ kind, id }) => {
    if (kind === 'repo') {
      const repo = state.repos.find((entry) => entry.id === id)
      return repo && splits(repo.path, wslMoveRepoPaths(repo)) ? [id] : []
    }
    const folder = state.folderWorkspaces.find((entry) => entry.id === id)
    return folder && splits(folder.folderPath, [folder.folderPath]) ? [id] : []
  })
}

function driveRoots(paths: readonly string[], distro: string): string[] {
  return paths.flatMap((path) => {
    const drive = wslUncDrivePathToWindows(path, distro)
    return drive ? [normalizeRuntimePathForComparison(drive)] : []
  })
}

function nests(left: string, right: string): boolean {
  return left === right || isInside(left, right) || isInside(right, left)
}

// Why: a drive root normalizes to `c:/`, which already ends in the separator.
function isInside(path: string, folder: string): boolean {
  return path.startsWith(folder.endsWith('/') ? folder : `${folder}/`)
}

/** The worktree id a converted project's worktree gets: same repo id, drive path. */
export function wslDriveUncWorktreeId(worktreeId: string, distro: string): string {
  return rewriteWorktreeIdPath(worktreeId, (path) => wslUncDrivePathToWindows(path, distro) ?? path)
}
