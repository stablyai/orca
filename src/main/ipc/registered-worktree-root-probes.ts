import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import type { Repo } from '../../shared/repo-types'
import { getErrorCode } from '../git/worktree-operation-options'
import { listRepoWorktreeGraph } from '../repo-worktrees'

const CREATED_WORKTREE_ROOT_PROBE_TIMEOUT_MS = 1_000
const AUTHORIZED_ROOTS_REBUILD_CONCURRENCY = 8

type ListedRoots = { roots: Set<string>; listingFailed: boolean }

export async function listWorktreeRootsWithConcurrency(
  repos: readonly Repo[]
): Promise<ListedRoots[]> {
  const results: ListedRoots[] = []
  let nextIndex = 0
  await Promise.all(
    Array.from(
      { length: Math.min(AUTHORIZED_ROOTS_REBUILD_CONCURRENCY, repos.length) },
      async () => {
        while (nextIndex < repos.length) {
          const index = nextIndex++
          const repo = repos[index]
          const roots = new Set([resolve(repo.path)])
          let listingFailed = false
          try {
            for (const worktree of await listRepoWorktreeGraph(repo)) {
              roots.add(resolve(worktree.path))
            }
          } catch (error) {
            console.warn(
              `[filesystem-auth] skipping repo ${repo.path} during cache rebuild:`,
              error
            )
            listingFailed = true
          }
          results[index] = { roots, listingFailed }
        }
      }
    )
  )
  return results
}

/** An unavailable mount is not evidence that a recovered worktree disappeared. */
export async function pruneCreatedWorktreeRoots(
  recoveredRoots: ReadonlySet<string>,
  listed: ListedRoots
): Promise<Set<string>> {
  const recovered = new Set(recoveredRoots)
  if (!listed.listingFailed) {
    await Promise.all(
      [...recovered].map(async (root) => {
        if (listed.roots.has(root) || (await isRootGoneFromDisk(root))) {
          recovered.delete(root)
        }
      })
    )
  }
  return recovered
}

async function isRootGoneFromDisk(targetPath: string): Promise<boolean> {
  const probe = stat(targetPath).then(
    () => false,
    (error: unknown) => getErrorCode(error) === 'ENOENT'
  )
  return withTimeout(probe, CREATED_WORKTREE_ROOT_PROBE_TIMEOUT_MS, false)
}
