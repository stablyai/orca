import { basename, join, resolve, relative, isAbsolute, posix, win32 } from 'path'
import type { GitWorktreeInfo, Worktree, WorktreeMeta, WorktreeLocation } from '../../shared/types'
import { getWslHome, parseWslPath } from '../wsl'

/**
 * Sanitize a worktree name for use in branch names and directory paths.
 * Strips unsafe characters and collapses runs of special chars to a single hyphen.
 */
export function sanitizeWorktreeName(input: string): string {
  const sanitized = input
    .trim()
    .replace(/[\\/]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')

  if (!sanitized || sanitized === '.' || sanitized === '..') {
    throw new Error('Invalid worktree name')
  }

  return sanitized
}

// Internal helper: same logic as ensurePathWithinWorkspace, but takes
// explicit path operations so UNC paths can be validated correctly on
// Linux CI (where platform-default posix.resolve mangles backslashes).
type PathOps = Pick<typeof win32, 'basename' | 'join' | 'resolve' | 'relative' | 'isAbsolute'>

function ensureWithinRoot(targetPath: string, root: string, ops: PathOps): string {
  const resolvedRoot = ops.resolve(root)
  const resolvedTarget = ops.resolve(targetPath)
  const rel = ops.relative(resolvedRoot, resolvedTarget)
  if (ops.isAbsolute(rel) || rel.startsWith('..')) {
    throw new Error('Invalid worktree path')
  }
  return resolvedTarget
}

function pickPathOps(...paths: string[]): PathOps {
  // Any Windows-looking path forces win32 so UNC paths validate correctly
  // on Linux CI. Otherwise we use platform default. This matches the
  // existing pathOps trick used elsewhere in this file.
  if (paths.some(looksLikeWindowsPath)) {
    return win32
  }
  return { basename, join, resolve, relative, isAbsolute }
}

/**
 * Ensure a target path is within the workspace directory (prevent path traversal).
 * Kept exported for backward compatibility with the existing test file; new code
 * should call ensureWithinRoot directly with explicit path operations.
 */
export function ensurePathWithinWorkspace(targetPath: string, workspaceDir: string): string {
  return ensureWithinRoot(targetPath, workspaceDir, pickPathOps(targetPath, workspaceDir))
}

/**
 * Compute the full branch name by applying the configured prefix strategy.
 */
export function computeBranchName(
  sanitizedName: string,
  settings: { branchPrefix: string; branchPrefixCustom?: string },
  gitUsername: string | null
): string {
  if (settings.branchPrefix === 'git-username') {
    if (gitUsername) {
      return `${gitUsername}/${sanitizedName}`
    }
  } else if (settings.branchPrefix === 'custom' && settings.branchPrefixCustom) {
    return `${settings.branchPrefixCustom}/${sanitizedName}`
  }
  return sanitizedName
}

/**
 * Compute the filesystem path where the worktree directory will be created.
 *
 * Three modes:
 * - in-repo: <repoPath>/.worktrees/<name> — co-located with the repo, opt-in.
 * - WSL: <wslHome>/orca/workspaces/... — keeps worktrees on the WSL filesystem
 *   when the repo lives there, avoiding cross-filesystem performance traps.
 * - external: <workspaceDir>/[<repo>]/<name> — the legacy default.
 *
 * Each branch wraps its result in ensureWithinRoot against the appropriate
 * workspace root for that mode. The validation lives inside this function so
 * the calling code does not need to know about WSL paths or mode-specific
 * roots.
 */
export function computeWorktreePath(
  sanitizedName: string,
  repoPath: string,
  settings: {
    nestWorkspaces: boolean
    workspaceDir: string
    worktreeLocation: WorktreeLocation
  }
): string {
  // In-repo mode runs first. Why: it bypasses both the WSL special case
  // (worktrees inherit the repo's filesystem automatically because they
  // live inside it) and the user-configured workspaceDir (which is
  // irrelevant when worktrees live inside the repo). Skipping straight
  // to this branch means the WSL override never fires for in-repo mode.
  if (settings.worktreeLocation === 'in-repo') {
    const ops = pickPathOps(repoPath)
    const worktreesRoot = ops.join(repoPath, '.worktrees')
    const candidate = ops.join(worktreesRoot, sanitizedName)
    return ensureWithinRoot(candidate, worktreesRoot, ops)
  }

  const wsl = parseWslPath(repoPath)
  if (wsl) {
    const wslHome = getWslHome(wsl.distro)
    if (wslHome) {
      // Why WSL special case: when the repo lives on a WSL filesystem,
      // worktrees must also live on the WSL filesystem. Creating them on
      // the Windows side (/mnt/c/...) would be extremely slow due to
      // cross-filesystem I/O and the terminal would open a Windows shell
      // instead of WSL. We mirror the Windows workspace layout inside
      // ~/orca/workspaces on the WSL filesystem. All path operations here
      // use win32 because WSL UNC paths are still Windows paths from
      // Node's perspective, and posix.resolve on Linux CI would mangle them.
      const wslWorkspaceDir = win32.join(wslHome, 'orca', 'workspaces')
      const candidate = settings.nestWorkspaces
        ? win32.join(wslWorkspaceDir, win32.basename(repoPath).replace(/\.git$/, ''), sanitizedName)
        : win32.join(wslWorkspaceDir, sanitizedName)
      return ensureWithinRoot(candidate, wslWorkspaceDir, win32)
    }
  }

  const ops = pickPathOps(repoPath, settings.workspaceDir)
  const candidate = settings.nestWorkspaces
    ? ops.join(settings.workspaceDir, ops.basename(repoPath).replace(/\.git$/, ''), sanitizedName)
    : ops.join(settings.workspaceDir, sanitizedName)
  return ensureWithinRoot(candidate, settings.workspaceDir, ops)
}

export function areWorktreePathsEqual(
  leftPath: string,
  rightPath: string,
  platform = process.platform
): boolean {
  if (platform === 'win32' || looksLikeWindowsPath(leftPath) || looksLikeWindowsPath(rightPath)) {
    const left = win32.normalize(win32.resolve(leftPath))
    const right = win32.normalize(win32.resolve(rightPath))
    // Why: `git worktree list` can report the same Windows path with different
    // slash styles or drive-letter casing than the path we computed before
    // creation. Orca must treat those as the same worktree or a successful
    // create spuriously fails until the next full reload repopulates state.
    return left.toLowerCase() === right.toLowerCase()
  }
  const left = posix.normalize(posix.resolve(leftPath))
  const right = posix.normalize(posix.resolve(rightPath))
  return left === right
}

function looksLikeWindowsPath(pathValue: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(pathValue) || pathValue.startsWith('\\\\')
}

/**
 * Determine whether a display name should be persisted.
 * A display name is set only when the user's requested name differs from
 * both the branch name and the sanitized name (i.e. it was modified).
 */
export function shouldSetDisplayName(
  requestedName: string,
  branchName: string,
  sanitizedName: string
): boolean {
  return !(branchName === requestedName && sanitizedName === requestedName)
}

/**
 * Merge raw git worktree info with persisted user metadata into a full Worktree.
 */
export function mergeWorktree(
  repoId: string,
  git: GitWorktreeInfo,
  meta: WorktreeMeta | undefined,
  defaultDisplayName?: string
): Worktree {
  const branchShort = git.branch.replace(/^refs\/heads\//, '')
  return {
    id: `${repoId}::${git.path}`,
    repoId,
    path: git.path,
    head: git.head,
    branch: git.branch,
    isBare: git.isBare,
    isMainWorktree: git.isMainWorktree,
    displayName: meta?.displayName || branchShort || defaultDisplayName || basename(git.path),
    comment: meta?.comment || '',
    linkedIssue: meta?.linkedIssue ?? null,
    linkedPR: meta?.linkedPR ?? null,
    isArchived: meta?.isArchived ?? false,
    isUnread: meta?.isUnread ?? false,
    sortOrder: meta?.sortOrder ?? 0,
    lastActivityAt: meta?.lastActivityAt ?? 0
  }
}

/**
 * Parse a composite worktreeId ("repoId::worktreePath") into its parts.
 */
export function parseWorktreeId(worktreeId: string): { repoId: string; worktreePath: string } {
  const sepIdx = worktreeId.indexOf('::')
  if (sepIdx === -1) {
    throw new Error(`Invalid worktreeId: ${worktreeId}`)
  }
  return {
    repoId: worktreeId.slice(0, sepIdx),
    worktreePath: worktreeId.slice(sepIdx + 2)
  }
}

/**
 * Check whether a git error indicates the worktree is no longer tracked by git.
 * This happens when a worktree's internal git tracking is removed (e.g. via
 * `git worktree prune`) but the directory still exists on disk.
 */
export function isOrphanedWorktreeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const msg = (error as { stderr?: string }).stderr || error.message
  return /is not a working tree/.test(msg)
}

/**
 * Format a human-readable error message for worktree removal failures.
 */
export function formatWorktreeRemovalError(
  error: unknown,
  worktreePath: string,
  force: boolean
): string {
  const fallback = force
    ? `Failed to force delete worktree at ${worktreePath}.`
    : `Failed to delete worktree at ${worktreePath}.`

  if (!(error instanceof Error)) {
    return fallback
  }

  const errorWithStreams = error as Error & { stderr?: string; stdout?: string }
  const details = [errorWithStreams.stderr, errorWithStreams.stdout, error.message]
    .map((value) => value?.trim())
    .find(Boolean)

  return details ? `${fallback} ${details}` : fallback
}
