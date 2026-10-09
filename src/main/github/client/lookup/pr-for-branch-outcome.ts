import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import {
  hostedReviewRepoScope,
  scopeGeneration
} from '../../../source-control/hosted-review-scope-generations'
import { runCoalescedProbe, type CoalescedProbes } from '../../../git/coalesced-probe'
import { getSshGitProviderGeneration } from '../../../providers/ssh-git-dispatch'
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
  const branchName = branch.replace(/^refs\/heads\//, '')
  // Why: detached HEAD can't use branch lookup, but an exact linked/fallback PR number is still safe to query and keeps review state visible.
  if (!branchName && typeof linkedPRNumber !== 'number' && typeof fallbackPRNumber !== 'number') {
    return { kind: 'no-pr', fetchedAt: Date.now() }
  }
  const localGitArgs = hostedReviewLocalGitOptionArgs(options)
  const localGitOptions = localGitArgs[0] ?? {}
  const context = githubRepoContext(repoPath, connectionId, localGitOptions)
  const ghOptions = ghRepoExecOptions(context)
  const executionScope = githubPRStackExecutionScope(connectionId, localGitOptions)

  const key = JSON.stringify([
    executionScope,
    connectionId ? getSshGitProviderGeneration(connectionId) : null,
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
