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
 * Find the row for a worktree `git worktree add` just created: first by asking Git about the new
 * worktree itself, then, only if that cannot confirm it, from the repo's full listing.
 *
 * Why direct first: the listing walks every registered worktree, so on a repo with hundreds of
 * them it put a disk-bound scan (up to ~57 s under load) on every create's critical path. The
 * listing stays as the fallback because a direct read can fail where Git still lists the row (#16520).
 */
/** A direct read that burned the whole budget still leaves the listing a chance to answer. */
const MIN_CREATED_WORKTREE_RECOVERY_MS = 5_000

export async function resolveCreatedWorktree(
  repoPath: string,
  worktreePath: string,
  branchName: string,
  options?: GitWorktreeExecOptions
): Promise<CreatedWorktreeResolution> {
  const startedAt = Date.now()
  let directError: unknown
  try {
    const described = await describeCreatedWorktree(repoPath, worktreePath, branchName, {
      ...options,
      timeout: options?.timeout ?? WORKTREE_LIST_TIMEOUT_MS
    })
    if (described) {
      return { created: described, worktrees: [], listingComplete: false }
    }
  } catch (err) {
    directError = err
  }

  let listingError: Error | undefined
  try {
    // One budget for verifying the create, not one per attempt: a hung Git already spent the
    // direct read's deadline, and charging the listing a fresh one doubles the wait before the error.
    const remainingMs = Math.max(
      WORKTREE_LIST_TIMEOUT_MS - (Date.now() - startedAt),
      MIN_CREATED_WORKTREE_RECOVERY_MS
    )
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
    if (directError !== undefined) {
      // The listing's failure stays the thrown one, but the direct read's reason -- often
      // `repo common dir unverifiable: ...` -- would otherwise vanish from the record entirely.
      console.warn('[worktrees:create] created-worktree direct read also failed', {
        err: directError,
        worktreePath
      })
    }
    throw listingError
  }
  const notFound = createdWorktreeNotFoundError(worktreePath, branchName)
  if (directError !== undefined) {
    // The listing simply omitted the row, so the direct read holds the only actionable failure.
    throw new Error(
      `${notFound.message}: ${directError instanceof Error ? directError.message : String(directError)}`,
      { cause: directError }
    )
  }
  throw notFound
}
