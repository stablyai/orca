import { withGitHubRepoExecution } from '../../github-repository-identity'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import {
  hostedReviewRepoScope,
  scopeGeneration
} from '../../../source-control/hosted-review-scope-generations'
import { runCoalescedProbe, type CoalescedProbes } from '../../../git/coalesced-probe'
import { githubReadExecutionScope } from '../../github-read-execution-scope'
import type { PRRefreshOutcome } from '../../../../shared/github/pull-request-refresh-types'
import { acquire, release, ghRepoExecOptions, githubRepoContext } from '../../gh-utils'
import { hostedReviewLocalGitOptionArgs, githubPRStackExecutionScope } from './../github-exec-scope'
import type { GitHubPRBranchLookupOptions } from './pull-request-lookup-data'
import { prRefreshUpstreamError } from './../gh-error-predicates'
import { resolvePRForBranchOutcome } from './branch-lookup-resolution'
const reads: CoalescedProbes<PRRefreshOutcome> = new Map()

export async function getPRForBranchOutcome(
  repoPath: string,
  branch: string,
  linkedPRNumber?: number | null,
  connectionId?: string | null,
  fallbackPRNumber?: number | null,
  options: GitHubPRBranchLookupOptions = {}
): Promise<PRRefreshOutcome> {
  return withGitHubRepoExecution(
    repoPath,
    connectionId,
    hostedReviewLocalGitOptionArgs(options)[0] ?? {},
    async (): Promise<PRRefreshOutcome> => {
      const branchName = branch.replace(/^refs\/heads\//, '')
      // Detached HEAD cannot discover by branch, but explicit PR numbers remain safe.
      if (
        !branchName &&
        typeof linkedPRNumber !== 'number' &&
        typeof fallbackPRNumber !== 'number'
      ) {
        return { kind: 'no-pr', fetchedAt: Date.now() }
      }
      const localGitArgs = hostedReviewLocalGitOptionArgs(options)
      const localGitOptions = localGitArgs[0] ?? {}
      const context = githubRepoContext(repoPath, connectionId, localGitOptions)
      const ghOptions = ghRepoExecOptions(context)
      const executionScope = githubPRStackExecutionScope(connectionId, localGitOptions)

      const key = JSON.stringify([
        executionScope,
        repoPath,
        scopeGeneration(hostedReviewRepoScope(repoPath, getRepoExecutionHostId({ connectionId }))),
        branchName,
        linkedPRNumber ?? null,
        fallbackPRNumber ?? null,
        options.acceptMergedFallbackPR ?? false,
        options.currentHeadOid ?? null,
        githubReadExecutionScope(ghOptions)
      ])
      return runCoalescedProbe(
        reads,
        key,
        async () => {
          await acquire()
          try {
            return await resolvePRForBranchOutcome({
              repoPath,
              branchName,
              linkedPRNumber,
              connectionId,
              fallbackPRNumber,
              options,
              localGitOptions,
              ghOptions,
              executionScope
            })
          } catch (err) {
            return prRefreshUpstreamError(err)
          } finally {
            release()
          }
        },
        2 * 60_000
      )
    }
  )
}
