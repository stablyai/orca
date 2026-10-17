import { ghExecFileAsync } from '../../gh-utils'
import type { OwnerRepo, ghRepoExecOptions } from '../../gh-utils'
import {
  githubHostExecOptions,
  githubRepositoryWebHost,
  type GitHubApiRepository
} from '../../github-api-repository'
import { noteRepositoryRateLimitSpend } from '../../rate-limit'
import type { GhExecOptions } from './../github-exec-scope'
import { isNoPullRequestError } from './../gh-error-predicates'
import {
  PR_LOOKUP_JSON_FIELDS,
  mapRestPullRequest,
  normalizePullRequestLookupData,
  pullRequestMatchesHeadRepository,
  type PullRequestLookupData,
  type RestPullRequest
} from './pull-request-lookup-data'
import { getPRByNumber } from './pr-number-lookup'
import {
  BRANCH_REVIEW_PAGE_SIZE,
  selectReviewForHead
} from '../../../source-control/branch-review-selection'

/** The PR whose head is exactly `headOwner:branchName`, filtered by GitHub (`head=` matches the owner and branch). */
export async function getRestPRForHead(
  prRepo: GitHubApiRepository,
  headOwner: string,
  branchName: string,
  ghOptions: ReturnType<typeof ghRepoExecOptions>
): Promise<PullRequestLookupData | null> {
  const head = encodeURIComponent(`${headOwner}:${branchName}`)
  const pr = await selectReviewForHead(
    async (states) => {
      if (states === 'open') {
        noteRepositoryRateLimitSpend(prRepo, 'core', 1, ghOptions)
      }
      const { stdout } = await ghExecFileAsync(
        [
          'api',
          `repos/${prRepo.owner}/${prRepo.repo}/pulls?head=${head}&state=${states}&per_page=${BRANCH_REVIEW_PAGE_SIZE}`
        ],
        { ...ghOptions, ...githubHostExecOptions(prRepo) }
      )
      const list: RestPullRequest[] = JSON.parse(stdout)
      return list
    },
    (pr) => pr.state.toLowerCase() === 'open'
  )
  return pr ? mapRestPullRequest(pr) : null
}

export async function hydrateBranchLookupWithExactPR(
  ownerRepo: OwnerRepo,
  branchData: PullRequestLookupData | null,
  ghOptions: GhExecOptions,
  executionScope: string
): Promise<PullRequestLookupData | null> {
  if (!branchData) {
    return null
  }
  try {
    return (
      (await getPRByNumber(ownerRepo, branchData.number, ghOptions, executionScope, branchData)) ??
      branchData
    )
  } catch {
    return branchData
  }
}

/** The PR for a branch pushed to `headRepo`, asked of each base candidate on that host. */
export async function lookupPRByHead(args: {
  candidates: OwnerRepo[]
  headRepo: OwnerRepo
  branchName: string
  ghOptions: GhExecOptions
  executionScope: string
}): Promise<{ data: PullRequestLookupData | null; dataRepo: OwnerRepo | null }> {
  const headHost = githubRepositoryWebHost(args.headRepo).trim().toLowerCase()
  for (const candidate of args.candidates) {
    if (githubRepositoryWebHost(candidate).trim().toLowerCase() !== headHost) {
      continue
    }
    const branchData = await getRestPRForHead(
      candidate,
      args.headRepo.owner,
      args.branchName,
      args.ghOptions
    )
    // Why: REST/list branch lookup identifies the PR cheaply; exact `gh pr view` carries review, merge-queue, and auto-merge state.
    const data = await hydrateBranchLookupWithExactPR(
      candidate,
      branchData,
      args.ghOptions,
      args.executionScope
    )
    if (data && pullRequestMatchesHeadRepository(data, candidate, args.headRepo)) {
      return { data, dataRepo: candidate }
    }
  }
  return { data: null, dataRepo: null }
}

/** No GitHub candidate resolved here: let `gh` find the branch's PR in its own repo context. */
export async function lookupPRByGhBranch(
  branchName: string,
  ghOptions: GhExecOptions
): Promise<PullRequestLookupData | null> {
  try {
    const { stdout } = await ghExecFileAsync(
      ['pr', 'view', branchName, '--json', PR_LOOKUP_JSON_FIELDS],
      ghOptions
    )
    const data: PullRequestLookupData = JSON.parse(stdout)
    return normalizePullRequestLookupData(data)
  } catch (err) {
    if (isNoPullRequestError(err)) {
      return null
    }
    throw err
  }
}
