import { realpath } from 'fs/promises'
import { resolve, relative, dirname, basename, isAbsolute } from 'path'
import type { Store } from '../persistence'
import { listRepoWorktrees } from '../repo-worktrees'

export const PATH_ACCESS_DENIED_MESSAGE =
  'Access denied: path resolves outside allowed directories. If this blocks a legitimate workflow, please file a GitHub issue.'

const authorizedExternalPaths = new Set<string>()
const registeredWorktreeRoots = new Set<string>()
let registeredWorktreeRootsDirty = true
let registeredWorktreeRootsRefresh: Promise<void> | null = null

export function authorizeExternalPath(targetPath: string): void {
  authorizedExternalPaths.add(resolve(targetPath))
}

export function invalidateAuthorizedRootsCache(): void {
  registeredWorktreeRootsDirty = true
}

/**
 * Check whether resolvedTarget is equal to or a descendant of resolvedBase.
 * Uses relative() so it works with both `/` (Unix) and `\` (Windows) separators.
 */
export function isDescendantOrEqual(resolvedTarget: string, resolvedBase: string): boolean {
  if (resolvedTarget === resolvedBase) {
    return true
  }
  const rel = relative(resolvedBase, resolvedTarget)
  // rel must not start with ".." and must not be an absolute path (e.g. different drive on Windows)
  // [Security Fix]: Added !isAbsolute(rel) to prevent drive traversal bypasses on Windows
  // where relative('D:\\repo', 'C:\\etc\\passwd') returns absolute path 'C:\\etc\\passwd'
  return (
    rel !== '' &&
    !rel.startsWith('..') &&
    !isAbsolute(rel) &&
    resolve(resolvedBase, rel) === resolvedTarget
  )
}

export function getAllowedRoots(store: Store): string[] {
  const roots = store.getRepos().map((repo) => resolve(repo.path))
  const workspaceDir = store.getSettings().workspaceDir
  if (workspaceDir) {
    roots.push(resolve(workspaceDir))
  }
  return roots
}

export function isPathAllowed(targetPath: string, store: Store): boolean {
  const resolvedTarget = resolve(targetPath)
  if (authorizedExternalPaths.has(resolvedTarget)) {
    return true
  }
  for (const authorizedPath of authorizedExternalPaths) {
    if (isDescendantOrEqual(resolvedTarget, authorizedPath)) {
      return true
    }
  }
  return getAllowedRoots(store).some((root) => isDescendantOrEqual(resolvedTarget, root))
}

export async function rebuildAuthorizedRootsCache(store: Store): Promise<void> {
  // Why: repos are processed in parallel so the cache rebuild completes in
  // wall-clock time proportional to the slowest single repo, not the sum of
  // all repos.  The previous sequential loop was the main bottleneck on
  // Windows where each `git worktree list` + realpath chain takes 500 ms+
  // due to slower process creation and antivirus I/O scanning.
  const repos = store.getRepos()
  const perRepoResults = await Promise.all(
    repos.map(async (repo) => {
      const roots: string[] = []
      try {
        roots.push(await normalizeExistingPath(repo.path))

        const worktrees = await listRepoWorktrees(repo)
        const worktreeRoots = await Promise.all(
          worktrees.map((wt) => normalizeExistingPath(wt.path))
        )
        roots.push(...worktreeRoots)
      } catch (error) {
        // Why: a single inaccessible repo (EACCES, EIO, etc.) must not break
        // the entire cache rebuild — that would disable File Explorer and
        // Quick Open for all other repos. We skip the failing repo and let
        // the rest proceed.
        console.warn(`[filesystem-auth] skipping repo ${repo.path} during cache rebuild:`, error)
      }
      return roots
    })
  )

  registeredWorktreeRoots.clear()
  for (const roots of perRepoResults) {
    for (const root of roots) {
      registeredWorktreeRoots.add(root)
    }
  }
  registeredWorktreeRootsDirty = false
}

export async function ensureAuthorizedRootsCache(store: Store): Promise<void> {
  if (!registeredWorktreeRootsDirty) {
    return
  }
  if (!registeredWorktreeRootsRefresh) {
    registeredWorktreeRootsRefresh = rebuildAuthorizedRootsCache(store).finally(() => {
      registeredWorktreeRootsRefresh = null
    })
  }
  await registeredWorktreeRootsRefresh
}

/**
 * Returns true if the error is an ENOENT (file-not-found) error.
 */
export function isENOENT(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

export async function resolveAuthorizedPath(targetPath: string, store: Store): Promise<string> {
  const resolvedTarget = resolve(targetPath)
  if (!(await isPathAllowedIncludingRegisteredWorktrees(resolvedTarget, store))) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }

  try {
    const realTarget = await realpath(resolvedTarget)
    if (!(await isPathAllowedIncludingRegisteredWorktrees(realTarget, store))) {
      throw new Error(PATH_ACCESS_DENIED_MESSAGE)
    }
    return realTarget
  } catch (error) {
    if (!isENOENT(error)) {
      throw error
    }

    const realParent = await realpath(dirname(resolvedTarget))
    const candidateTarget = resolve(realParent, basename(resolvedTarget))
    if (!(await isPathAllowedIncludingRegisteredWorktrees(candidateTarget, store))) {
      throw new Error(PATH_ACCESS_DENIED_MESSAGE)
    }
    return candidateTarget
  }
}

async function isPathAllowedIncludingRegisteredWorktrees(
  targetPath: string,
  store: Store
): Promise<boolean> {
  if (isPathAllowed(targetPath, store)) {
    return true
  }

  await ensureAuthorizedRootsCache(store)

  // Why: external linked worktrees are already trusted for git operations.
  // Cache their normalized roots once and reuse that index so quick-open and
  // file explorer do not spawn `git worktree list` on every filesystem read.
  for (const root of registeredWorktreeRoots) {
    if (isDescendantOrEqual(targetPath, root)) {
      return true
    }
  }

  return false
}

async function normalizeExistingPath(targetPath: string): Promise<string> {
  try {
    return await realpath(targetPath)
  } catch {
    return resolve(targetPath)
  }
}

/**
 * Resolve and verify that a worktree path belongs to a registered repo.
 *
 * Why this doesn't use resolveAuthorizedPath: linked worktrees can live
 * anywhere on disk (e.g. ~/.codex/worktrees/), far outside the repo root
 * and workspaceDir that resolveAuthorizedPath allows.  The security boundary
 * for git operations is *worktree registration* — the path must match a
 * worktree reported by `git worktree list` for a known repo — not
 * directory containment within allowed roots.
 */
export async function resolveRegisteredWorktreePath(
  worktreePath: string,
  store: Store
): Promise<string> {
  // Reject obviously malformed paths early — mirrors the null-byte check in
  // validateGitRelativeFilePath and prevents probing via realpath.
  if (!worktreePath || worktreePath.includes('\0')) {
    throw new Error('Access denied: invalid worktree path')
  }

  const resolvedTarget = resolve(worktreePath)

  // Resolve through symlinks when the path exists on disk, so that we
  // compare canonical paths on both sides (git worktree list also resolves
  // symlinks).
  const normalizedTarget = await normalizeExistingPath(resolvedTarget)

  await ensureAuthorizedRootsCache(store)
  for (const root of registeredWorktreeRoots) {
    if (normalizedTarget === root) {
      return normalizedTarget
    }
  }

  throw new Error('Access denied: unknown repository or worktree path')
}

export function validateGitRelativeFilePath(worktreePath: string, filePath: string): string {
  if (!filePath || filePath.includes('\0') || resolve(filePath) === filePath) {
    throw new Error('Access denied: invalid git file path')
  }

  const resolvedFilePath = resolve(worktreePath, filePath)
  if (!isDescendantOrEqual(resolvedFilePath, worktreePath)) {
    throw new Error('Access denied: git file path escapes the selected worktree')
  }

  const normalizedRelativePath = relative(worktreePath, resolvedFilePath)
  if (!normalizedRelativePath) {
    throw new Error('Access denied: invalid git file path')
  }

  return normalizedRelativePath
}
