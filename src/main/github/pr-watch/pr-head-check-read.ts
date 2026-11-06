import type { GitHubPRRefreshCandidate } from '../../../shared/github/pull-request-refresh-types'
import { PR_CHECK_PAGE_LIMIT } from '../client/check/pr-check-rollup'
import { readRestPRCheckRollup } from '../client/check/rest-pr-check-pages'
import {
  ghRepoExecOptions,
  githubRepoContext,
  withGitHubRepoExecution
} from '../github-repository-identity'

/** One earlier head's checks by SHA (REST, bounded); never a current-head observation. */
export function readPRHeadCheckRollup(
  candidate: GitHubPRRefreshCandidate,
  pr: { host: string; owner: string; repo: string },
  headSha: string
): Promise<unknown[]> {
  const localGitOptions = {
    ...(candidate.localGitOptions?.wslDistro
      ? { wslDistro: candidate.localGitOptions.wslDistro }
      : {}),
    admissionTier: 'background' as const
  }
  return withGitHubRepoExecution(candidate.repoPath, candidate.connectionId, localGitOptions, () =>
    readRestPRCheckRollup(
      { owner: pr.owner, repo: pr.repo, ...(pr.host === 'github.com' ? {} : { host: pr.host }) },
      headSha,
      ghRepoExecOptions(
        githubRepoContext(candidate.repoPath, candidate.connectionId, localGitOptions)
      ),
      PR_CHECK_PAGE_LIMIT
    )
  )
}
