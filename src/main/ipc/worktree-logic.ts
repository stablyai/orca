import { basename, join, resolve, relative, isAbsolute } from 'path'
import type { Worktree, WorktreeMeta } from '../../shared/types'

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
 */
export function computeWorktreePath(
  sanitizedName: string,
  repoPath: string,
  settings: { nestWorkspaces: boolean; workspaceDir: string }
): string {
  if (settings.nestWorkspaces) {
    const repoName = basename(repoPath).replace(/\.git$/, '')
    return join(settings.workspaceDir, repoName, sanitizedName)
  }
  return join(settings.workspaceDir, sanitizedName)
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
  git: { path: string; head: string; branch: string; isBare: boolean },
  meta: WorktreeMeta | undefined
): Worktree {
  const branchShort = git.branch.replace(/^refs\/heads\//, '')
  return {
    id: `${repoId}::${git.path}`,
    repoId,
    path: git.path,
    head: git.head,
    branch: git.branch,
    isBare: git.isBare,
    displayName: meta?.displayName || branchShort || basename(git.path),
    comment: meta?.comment || '',
    linkedIssue: meta?.linkedIssue ?? null,
    linkedPR: meta?.linkedPR ?? null,
    isArchived: meta?.isArchived ?? false,
    isUnread: meta?.isUnread ?? false,
    sortOrder: meta?.sortOrder ?? 0
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
