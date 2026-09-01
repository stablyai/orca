// Why: a narrow fork-remote refspec (#17828) pins an exact `refs/heads/<branch>`, so
// if that branch is later deleted or renamed upstream (e.g. the contributor deletes it
// after merge), a plain `git fetch <remote>` using the configured refspec exits nonzero
// with "couldn't find remote ref" -- and fetches NOTHING for that remote, not even other
// branches it also tracks. A wide refspec never had this failure mode (unmatched
// wildcards are silently skipped), so this is a new risk the narrow refspec introduces
// and must self-heal rather than surface as a broken Fetch button.
import { extractExecError } from './exec-error'
import { removeStaleForkFetchRefspec, type GitExecFn } from './fork-remote-refspec'

const MISSING_REMOTE_REF_PATTERN = /couldn't find remote ref (refs\/heads\/\S+)/

export function parseMissingForkBranchRef(stderr: string): string | null {
  return MISSING_REMOTE_REF_PATTERN.exec(stderr)?.[1] ?? null
}

// Bounds the repair loop; git reports one missing ref per fetch attempt (see #17828 PR
// description), so this comfortably covers even a fork remote tracking many stale branches.
const MAX_STALE_REFSPEC_REPAIR_ATTEMPTS = 20

/**
 * Runs `runFetch`, and on a "couldn't find remote ref" failure for a refspec this remote
 * tracks, drops that one stale refspec and retries -- so a branch deleted upstream degrades
 * to "no longer updates for that branch" instead of "fetch fails for the whole remote".
 */
export async function fetchForkRemoteWithStaleRefspecRepair(
  execGit: GitExecFn,
  repoPath: string,
  remoteName: string,
  runFetch: () => Promise<void>
): Promise<void> {
  for (let attempt = 0; attempt < MAX_STALE_REFSPEC_REPAIR_ATTEMPTS; attempt += 1) {
    try {
      await runFetch()
      return
    } catch (error) {
      const staleRef = parseMissingForkBranchRef(extractExecError(error).stderr)
      const staleBranch = staleRef?.replace(/^refs\/heads\//, '')
      if (
        !staleBranch ||
        !(await removeStaleForkFetchRefspec(execGit, repoPath, remoteName, staleBranch))
      ) {
        throw error
      }
      // loop: retry now that the dead refspec is gone
    }
  }
  throw new Error(`Exceeded stale fork-remote refspec repair attempts for "${remoteName}"`)
}
