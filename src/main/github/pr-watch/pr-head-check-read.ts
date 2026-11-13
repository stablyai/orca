import type { GitHubPRRefreshCandidate } from '../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import { PR_CHECK_PAGE_LIMIT } from '../client/check/pr-check-rollup'
import { readRestPRCheckRollup } from '../client/check/rest-pr-check-pages'
import type { GhExecOptions } from '../client/github-exec-scope'
import { assertRateLimitBudget } from '../client/lookup/pr-lookup-rate-limit'
import { ghExecFileAsync } from '../../git/command-runner/hosted-cli/gh-exec-file'
import { githubHostExecOptions } from '../repositories/github-repository-host'
import type { GitHubRepositoryIdentity as GitHubApiRepository } from '../../../shared/github/repositories/repository-identity'
import { noteRepositoryRateLimitSpend } from '../api/rate-limit'
import {
  ghRepoExecOptions,
  githubRepoContext,
  withGitHubRepoExecution
} from '../repositories/github-repository-identity'

type PRRepository = { host: string; owner: string; repo: string }

/** A background REST read in the candidate checkout's GitHub execution scope. */
function withPRRepository<T>(
  candidate: GitHubPRRefreshCandidate,
  pr: PRRepository,
  read: (repository: GitHubApiRepository, options: GhExecOptions) => Promise<T>
): Promise<T> {
  const localGitOptions = {
    ...(candidate.localGitOptions?.wslDistro
      ? { wslDistro: candidate.localGitOptions.wslDistro }
      : {}),
    admissionTier: 'background' as const
  }
  return withGitHubRepoExecution(candidate.repoPath, candidate.connectionId, localGitOptions, () =>
    read(
      { owner: pr.owner, repo: pr.repo, ...(pr.host === 'github.com' ? {} : { host: pr.host }) },
      ghRepoExecOptions(
        githubRepoContext(candidate.repoPath, candidate.connectionId, localGitOptions)
      )
    )
  )
}

/** One earlier head's checks by SHA (REST, bounded); never a current-head observation. */
export function readPRHeadCheckRollup(
  candidate: GitHubPRRefreshCandidate,
  pr: PRRepository,
  headSha: string
): Promise<unknown[]> {
  return withPRRepository(candidate, pr, (repository, options) =>
    readRestPRCheckRollup(repository, headSha, options, PR_CHECK_PAGE_LIMIT)
  )
}

/** The full SHA of a commit git printed abbreviated, or null when GitHub names none matching. */
export function resolvePRCommitSha(
  candidate: GitHubPRRefreshCandidate,
  pr: PRRepository,
  abbreviated: string
): Promise<string | null> {
  return withPRRepository(candidate, pr, async (repository, options) => {
    await assertRateLimitBudget('core', repository, options)
    const { stdout } = await ghExecFileAsync(
      [
        'api',
        `repos/${repository.owner}/${repository.repo}/commits/${encodeURIComponent(abbreviated)}`,
        '--jq',
        '.sha'
      ],
      { ...options, ...githubHostExecOptions(repository) }
    )
    noteRepositoryRateLimitSpend(repository, 'core', 1, options)
    const sha = stdout.trim().toLowerCase()
    return /^[0-9a-f]{40,64}$/u.test(sha) && sha.startsWith(abbreviated.toLowerCase()) ? sha : null
  })
}

/** Whether `sha` is already in the PR's history: an ancestor of, or the same as, its head. */
export function isCommitInPRHead(
  candidate: GitHubPRRefreshCandidate,
  pr: PRRepository,
  sha: string,
  headSha: string
): Promise<boolean> {
  return withPRRepository(candidate, pr, async (repository, options) => {
    await assertRateLimitBudget('core', repository, options)
    const path = `repos/${repository.owner}/${repository.repo}/compare/${encodeURIComponent(sha)}...${encodeURIComponent(headSha)}`
    const { stdout } = await ghExecFileAsync(['api', path, '--jq', '.status'], {
      ...options,
      ...githubHostExecOptions(repository)
    })
    noteRepositoryRateLimitSpend(repository, 'core', 1, options)
    const status = stdout.trim()
    return status === 'ahead' || status === 'identical'
  })
}
