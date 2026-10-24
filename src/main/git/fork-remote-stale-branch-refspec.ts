// Literal stale refspecs can fail the entire fetch; wildcard zero-match tolerance does not cover them.
import { extractExecError } from './exec-error'
import { removeStaleForkFetchRefspec, type GitExecFn } from './fork-remote-refspec'

const MISSING_REMOTE_REF_PATTERN = /couldn't find remote ref (refs\/heads\/\S+)/

export function parseMissingForkBranchRef(stderr: string): string | null {
  return MISSING_REMOTE_REF_PATTERN.exec(stderr)?.[1] ?? null
}

// Git reports one missing ref per fetch; bound the repair loop.
const MAX_STALE_REFSPEC_REPAIR_ATTEMPTS = 20

/** Remove a configured literal refspec only when Git reports its source missing, then retry. */
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
    }
  }
  throw new Error(`Exceeded stale fork-remote refspec repair attempts for "${remoteName}"`)
}
