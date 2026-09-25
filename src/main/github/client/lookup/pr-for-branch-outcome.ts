import type { PRRefreshOutcome } from '../../../../shared/github/pull-request-refresh-types'
import { acquire, release, ghRepoExecOptions, githubRepoContext } from '../../gh-utils'
import { hostedReviewLocalGitOptionArgs, githubPRStackExecutionScope } from './../github-exec-scope'
import type { GitHubPRBranchLookupOptions } from './pull-request-lookup-data'
import { prRefreshUpstreamError } from './../gh-error-predicates'
import { resolvePRForBranchOutcome } from './branch-lookup-resolution'
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
}
