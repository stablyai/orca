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
  /** Rows `git worktree list` returned; empty when the direct read found the worktree. */
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

/** A failed direct read still leaves the listing a chance to verify the create. */
const MIN_CREATED_WORKTREE_LIST_FALLBACK_MS = 5_000

/** Verify the new checkout directly; listing every existing worktree is only a fallback. */
export async function resolveCreatedWorktree(
  repoPath: string,
  worktreePath: string,
  branchName: string,
  options?: GitWorktreeExecOptions
): Promise<CreatedWorktreeResolution> {
  const startedAt = Date.now()
  let directReadError: Error | undefined
  try {
    const created = options
      ? await describeCreatedWorktree(repoPath, worktreePath, branchName, options)
      : await describeCreatedWorktree(repoPath, worktreePath, branchName)
    if (created) {
      return { created, worktrees: [], listingComplete: false }
    }
  } catch (err) {
    directReadError = err instanceof Error ? err : new Error(String(err))
  }

  const remainingMs = Math.max(
    (options?.timeout ?? WORKTREE_LIST_TIMEOUT_MS) - (Date.now() - startedAt),
    MIN_CREATED_WORKTREE_LIST_FALLBACK_MS
  )
  let listingError: Error | undefined
  try {
    const worktrees = await listWorktreesSharedStrict(repoPath, {
      ...options,
      timeout: options?.timeout ?? remainingMs
    })
    const created = findCreatedWorktree(worktrees, worktreePath, branchName)
    if (created) {
      return { created, worktrees, listingComplete: true }
    }
  } catch (err) {
    listingError = err instanceof Error ? err : new Error(String(err))
  }
  if (listingError) {
    if (directReadError) {
      console.warn('[worktrees:create] created-worktree recovery also failed', {
        err: directReadError,
        worktreePath
      })
    }
    throw listingError
  }
  const notFound = createdWorktreeNotFoundError(worktreePath, branchName)
  if (directReadError) {
    throw new Error(`${notFound.message}: ${directReadError.message}`, { cause: directReadError })
  }
  throw notFound
}
