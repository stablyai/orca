import { basename, join, resolve, relative, isAbsolute, posix, win32 } from 'path'
import type { GitWorktreeInfo, Worktree, WorktreeMeta } from '../../shared/types'
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
    // Why: git check-ref-format rejects any ref containing `..`, so a prompt
    // like "../../foo" that survives slugification as `..-..-foo` would
    // produce a branch name git refuses to create. Collapse runs of dots
    // to a single dot before the leading/trailing trim so internal `..`
    // sequences can't reach git.
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '')

  if (!sanitized || sanitized === '.' || sanitized === '..') {
    throw new Error('Invalid worktree name')
  }

  return sanitized
}

/**
 * Ensure a target path is within the workspace directory (prevent path traversal).
 */
export function ensurePathWithinWorkspace(targetPath: string, workspaceDir: string): string {
  const resolvedWorkspaceDir = resolve(workspaceDir)
  const resolvedTargetPath = resolve(targetPath)
  const rel = relative(resolvedWorkspaceDir, resolvedTargetPath)

  if (isAbsolute(rel) || rel.startsWith('..')) {
    throw new Error('Invalid worktree path')
  }

  return resolvedTargetPath
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
 * Why WSL special case: when the repo lives on a WSL filesystem, worktrees
 * must also live on the WSL filesystem. Creating them on the Windows side
 * (/mnt/c/...) would be extremely slow due to cross-filesystem I/O and
 * the terminal would open a Windows shell instead of WSL. We mirror the
 * Windows workspace layout inside ~/orca/workspaces on the WSL filesystem
 * (e.g. \\wsl.localhost\Ubuntu\home\user\orca\workspaces\repo\feature).
 */
export function computeWorktreePath(
  sanitizedName: string,
  repoPath: string,
  settings: { nestWorkspaces: boolean; workspaceDir: string }
): string {
  const pathOps =
    looksLikeWindowsPath(repoPath) || looksLikeWindowsPath(settings.workspaceDir)
      ? win32
      : { basename, join }

  const wsl = parseWslPath(repoPath)
  if (wsl) {
    const wslHome = getWslHome(wsl.distro)
    if (wslHome) {
      // Why: WSL UNC paths are still Windows paths from Node's perspective.
      // On Linux CI, the default path helpers use POSIX semantics and would
      // treat `\\wsl.localhost\...` as a plain string, producing mixed-separator
      // paths like `\\wsl.localhost\Ubuntu\home\jin/orca/...`. Use win32 path
      // operations whenever a Windows/UNC path is involved so behavior matches
      // the Windows production runtime.
      const wslWorkspaceDir = win32.join(wslHome, 'orca', 'workspaces')
      if (settings.nestWorkspaces) {
        const repoName = win32.basename(repoPath).replace(/\.git$/, '')
        return win32.join(wslWorkspaceDir, repoName, sanitizedName)
      }
      return win32.join(wslWorkspaceDir, sanitizedName)
    }
  }

  if (settings.nestWorkspaces) {
    const repoName = pathOps.basename(repoPath).replace(/\.git$/, '')
    return pathOps.join(settings.workspaceDir, repoName, sanitizedName)
  }
  return pathOps.join(settings.workspaceDir, sanitizedName)
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
    linkedLinearIssue: meta?.linkedLinearIssue ?? null,
    isArchived: meta?.isArchived ?? false,
    isUnread: meta?.isUnread ?? false,
    isPinned: meta?.isPinned ?? false,
    sortOrder: meta?.sortOrder ?? 0,
    lastActivityAt: meta?.lastActivityAt ?? 0,
    // Why: diff comments are persisted on WorktreeMeta (see `WorktreeMeta` in
    // shared/types) and forwarded verbatim so the renderer store mirrors
    // on-disk state. `undefined` here means the worktree has no comments yet.
    diffComments: meta?.diffComments
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
