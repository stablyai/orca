import { posix, win32 } from 'node:path'
import {
  isWindowsAbsolutePathLike,
  normalizeRuntimePathForComparison,
  resolveRuntimePath
} from '../../shared/cross-platform-path'
import { isWslUncPath } from '../../shared/wsl-paths'
import { getWslHome, getWslHomeAsync, parseWslPath } from '../wsl'

// Where a repo's workspace root resolves, including the WSL mirror. Split from worktree-logic so
// placement and the nested-folder collision check share one resolver.

type WorkspaceRootSettings = { workspaceDir: string; wslMirrorDistro?: string }

export function getRuntimePathOps(
  repoPath: string,
  workspaceDir: string
): Pick<typeof posix, 'basename' | 'isAbsolute' | 'join' | 'normalize'> {
  return isWindowsAbsolutePathLike(repoPath) || isWindowsAbsolutePathLike(workspaceDir)
    ? win32
    : posix
}

function resolveWorkspaceDirForRepo(repoPath: string, workspaceDir: string): string {
  const pathOps = getRuntimePathOps(repoPath, workspaceDir)
  return pathOps.isAbsolute(workspaceDir)
    ? pathOps.normalize(workspaceDir)
    : resolveRuntimePath(repoPath, workspaceDir)
}

export function isWorkspaceDirRelativeToRepo(repoPath: string, workspaceDir: string): boolean {
  return !getRuntimePathOps(repoPath, workspaceDir).isAbsolute(workspaceDir)
}

/** Repo folder name without `.git`: the nested folder when no other repo competes for it, and the
 *  `<name>.worktrees` stem for the sibling layout. */
export function getRepoFolderName(repoPath: string): string {
  return getRuntimePathOps(repoPath, repoPath)
    .basename(repoPath)
    .replace(/\.git$/, '')
}

/** Comparison key for `<workspace root>/<dirName>`, computed without probing a WSL home so a
 *  sweep over every repo stays cheap. Equal keys mean the same directory. */
export function getNestedRepoDirComparisonKey(
  repoPath: string,
  settings: WorkspaceRootSettings,
  dirName: string
): string {
  const distro = mirrorDistroForWorkspaceRoot(repoPath, settings)
  if (distro) {
    // Why: every mirrored repo of one distro shares `<distro home>/orca/workspaces`.
    return `wsl-mirror:${distro.toLowerCase()}:${dirName.normalize('NFC')}`
  }
  return normalizeRuntimePathForComparison(
    resolveRuntimePath(resolveWorkspaceDirForRepo(repoPath, settings.workspaceDir), dirName)
  )
}

/** Async twin of computeWorkspaceRoot. Same result; the WSL home probe spawns `wsl.exe`, so
 *  background preparation uses this variant rather than blocking the Electron main thread for up
 *  to the probe timeout. The sync twin below still serves callers that cannot await (allowed-roots
 *  resolution, CLI create, watch targets, worktree trash). */
export async function computeWorkspaceRootAsync(
  repoPath: string,
  settings: WorkspaceRootSettings
): Promise<string> {
  const distro = mirrorDistroForWorkspaceRoot(repoPath, settings)
  return workspaceRootForMirrorHome(
    repoPath,
    settings.workspaceDir,
    distro ? await getWslHomeAsync(distro) : null
  )
}

export function computeWorkspaceRoot(repoPath: string, settings: WorkspaceRootSettings): string {
  const distro = mirrorDistroForWorkspaceRoot(repoPath, settings)
  return workspaceRootForMirrorHome(
    repoPath,
    settings.workspaceDir,
    distro ? getWslHome(distro) : null
  )
}

/** Distro to mirror the workspace root into, or undefined when the configured root is used as-is.
 *  Shared by both resolvers so the sync and async paths can never disagree on placement. */
function mirrorDistroForWorkspaceRoot(
  repoPath: string,
  settings: WorkspaceRootSettings
): string | undefined {
  const distro = resolveMirrorDistro(repoPath, settings)
  return distro && shouldMirrorWorkspaceDirInsideWsl(repoPath, settings.workspaceDir)
    ? distro
    : undefined
}

function workspaceRootForMirrorHome(
  repoPath: string,
  workspaceDir: string,
  wslHome: string | null
): string {
  // Why: WSL UNC paths are still Windows paths from Node's perspective.
  // Mirror absolute local desktop workspace roots inside the distro so
  // terminals stay on the WSL filesystem; repo-relative roots can resolve
  // directly against the WSL repo path.
  return wslHome
    ? win32.join(wslHome, 'orca', 'workspaces')
    : resolveWorkspaceDirForRepo(repoPath, workspaceDir)
}

/**
 * Which distro's filesystem this repo's worktrees belong on, if any.
 *
 * A repo already inside WSL names its own distro. A repo on a Windows drive
 * names none — but if this project's git runs in WSL, its worktrees still
 * belong on the Linux side: `git status` stats every working-tree file, and
 * doing that across the 9p mount is ~20x slower than the same clean tree on
 * ext4 (`git worktree add` ~26x), with only the gitdir left on the Windows drive.
 */
function resolveMirrorDistro(
  repoPath: string,
  settings: { wslMirrorDistro?: string }
): string | undefined {
  const wsl = parseWslPath(repoPath)
  if (wsl) {
    return wsl.distro
  }
  return isWindowsAbsolutePathLike(repoPath) ? settings.wslMirrorDistro : undefined
}

function shouldMirrorWorkspaceDirInsideWsl(repoPath: string, workspaceDir: string): boolean {
  if (isWorkspaceDirRelativeToRepo(repoPath, workspaceDir)) {
    return false
  }
  return !isWslUncPath(workspaceDir)
}
