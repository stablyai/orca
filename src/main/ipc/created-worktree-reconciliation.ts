import { describeCreatedWorktree, listWorktreesSharedStrict } from '../git/worktree'
// Not via the worktree barrel: suites mock that module wholesale and would blank the constant.
import { WORKTREE_LIST_TIMEOUT_MS } from '../git/worktree-operation-options'
import type { GitWorktreeExecOptions } from '../git/worktree'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import { areWorktreePathsEqual } from './worktree-path-comparison'

export function findCreatedWorktree<T extends { path: string; branch?: string }>(
  worktrees: readonly T[],
  requestedPath: string,
  branchName: string,
  platform = process.platform
): T | undefined {
  const direct = worktrees.find((worktree) =>
    areWorktreePathsEqual(worktree.path, requestedPath, platform)
  )
  if (direct) {
    return direct
  }

  return worktrees.find((worktree) => worktree.branch === `refs/heads/${branchName}`)
}

export type CreatedWorktreeResolution = {
  created: GitWorktreeInfo
  /** Rows `git worktree list` returned; empty when only the direct read found the worktree. */
  worktrees: readonly GitWorktreeInfo[]
  /** Whether `worktrees` is the repo's whole listing, and so usable as its authorized-root set. */
  listingComplete: boolean
}

/** `created but not found in listing` is load-bearing for `classifyWorkspaceCreateError`. */
export function createdWorktreeNotFoundError(worktreePath: string, branchName: string): Error {
  return new Error(
    `Worktree created but not found in listing: ${worktreePath} (branch ${branchName})`
  )
}

/**
 * Find the row for a worktree `git worktree add` just created, preferring the repo listing and
 * falling back to asking Git about the worktree itself.
 *
 * Why the fallback: the listing was the only witness the old code had, so any Git-level listing
 * failure failed a create whose worktree and branch were already on disk, orphaning both (#16520).
 */
/** A listing that burned the whole budget still leaves the direct read a chance to answer. */
const MIN_CREATED_WORKTREE_RECOVERY_MS = 5_000

export async function resolveCreatedWorktree(
  repoPath: string,
  worktreePath: string,
  branchName: string,
  options?: GitWorktreeExecOptions
): Promise<CreatedWorktreeResolution> {
  const startedAt = Date.now()
  let listingError: unknown
  try {
    const worktrees = options
      ? await listWorktreesSharedStrict(repoPath, options)
      : await listWorktreesSharedStrict(repoPath)
    const created = findCreatedWorktree(worktrees, worktreePath, branchName)
    if (created) {
      return { created, worktrees, listingComplete: true }
    }
  } catch (err) {
    listingError = err
  }

  let described: GitWorktreeInfo | undefined
  let describeError: unknown
  try {
    // One budget for verifying the create, not one per attempt: a hung Git already spent the
    // listing's deadline, and charging the recovery a fresh one doubles the wait before the error.
    const remainingMs = Math.max(
      WORKTREE_LIST_TIMEOUT_MS - (Date.now() - startedAt),
      MIN_CREATED_WORKTREE_RECOVERY_MS
    )
    described = await describeCreatedWorktree(repoPath, worktreePath, branchName, {
      ...options,
      timeout: options?.timeout ?? remainingMs
    })
  } catch (err) {
    // Why keep, not rethrow: the recovery must not replace the listing's own, more informative failure.
    describeError = err
  }
  if (described) {
    return { created: described, worktrees: [], listingComplete: false }
  }
  if (listingError) {
    throw listingError
  }
  const notFound = createdWorktreeNotFoundError(worktreePath, branchName)
  if (describeError) {
    // The listing simply omitted the row, so the direct read holds the only actionable failure.
    throw new Error(
      `${notFound.message}: ${describeError instanceof Error ? describeError.message : String(describeError)}`
    )
  }
  throw notFound
}
