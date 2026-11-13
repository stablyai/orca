import { assertRateLimitBudget } from './pr-lookup-rate-limit'
import { selectBranchReview } from '../../../source-control/branch-review-selection'
import { ghExecFileAsync } from '../../../git/command-runner/hosted-cli/gh-exec-file'
import type {
  GitHubRepositoryIdentity as OwnerRepo,
  GitHubRepositoryIdentity as GitHubApiRepository
} from '../../../../shared/github/repositories/repository-identity'
import type { ghRepoExecOptions } from '../../repositories/github-repository-identity'
import {
  githubHostExecOptions,
  githubRepositoryWebHost
} from '../../repositories/github-repository-host'

import type { GhExecOptions } from './../github-exec-scope'
import { isNoPullRequestError } from './../gh-error-predicates'
import {
  PR_LOOKUP_JSON_FIELDS,
  normalizePullRequestLookupData,
  PR_BRANCH_LIST_JSON_FIELDS,
  mapRestPullRequest,
  pullRequestMatchesHeadRepository,
  type PullRequestLookupData,
  type PullRequestLookupPolicy,
  type RestPullRequest
} from './pull-request-lookup-data'
import { getPRByNumber } from './pr-number-lookup'
import { hydratePullRequestLookupData } from './pull-request-lookup-hydration'
import type { PRProviderReadOptions } from './shared-pr-provider-reads'
import { revalidateGitHubRestJson } from '../../api/github-rest-revalidation'
import { noteRepositoryRateLimitSpend } from '../../api/rate-limit'
import { ownerRepoFromPullRequestUrl } from '../github-exec-scope'

const BRANCH_PR_LOOKUP_PAGE_SIZE = 10

function parseBranchList<T extends { state: string; number: number }>(stdout: string): T[] {
  const parsed: unknown = JSON.parse(stdout)
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (row) =>
        row && typeof row.state === 'string' && Number.isInteger(row.number) && row.number > 0
    )
  ) {
    throw new Error('Invalid branch review list')
  }
  return parsed
}

export async function getRestPRForBranch(
  prRepo: GitHubApiRepository,
  headOwner: string,
  branchName: string,
  ghOptions: ReturnType<typeof ghRepoExecOptions>
): Promise<PullRequestLookupData | null> {
  const head = encodeURIComponent(`${headOwner}:${branchName}`)
  const read = async (state: 'all' | 'open', limit: number): Promise<RestPullRequest[]> =>
    parseBranchList<RestPullRequest>(
      await revalidateGitHubRestJson(
        prRepo,
        `repos/${prRepo.owner}/${prRepo.repo}/pulls?head=${head}&state=${state}&per_page=${limit}`,
        ghOptions
      )
    )
  const pr = await selectBranchReview({
    readRecent: () => read('all', BRANCH_PR_LOOKUP_PAGE_SIZE),
    readActive: async () => (await read('open', 1))[0] ?? null,
    isActive: (row) => row.state.toLowerCase() === 'open',
    pageSize: BRANCH_PR_LOOKUP_PAGE_SIZE
  })
  return pr ? mapRestPullRequest(pr) : null
}

export async function getFallbackPRListForBranch(
  prRepo: GitHubApiRepository,
  branchName: string,
  ghOptions: ReturnType<typeof ghRepoExecOptions>
): Promise<PullRequestLookupData | null> {
  const read = async (state: 'all' | 'open', limit: number): Promise<PullRequestLookupData[]> => {
    await assertRateLimitBudget('graphql', prRepo, ghOptions)
    noteRepositoryRateLimitSpend(prRepo, 'graphql', 1, ghOptions)
    const { stdout } = await ghExecFileAsync(
      [
        'pr',
        'list',
        '--repo',
        `${prRepo.owner}/${prRepo.repo}`,
        '--head',
        branchName,
        '--state',
        state,
        '--limit',
        String(limit),
        '--json',
        PR_BRANCH_LIST_JSON_FIELDS
      ],
      { ...ghOptions, ...githubHostExecOptions(prRepo) }
    )
    return parseBranchList<PullRequestLookupData>(stdout)
  }
  const pr = await selectBranchReview({
    readRecent: () => read('all', BRANCH_PR_LOOKUP_PAGE_SIZE),
    readActive: async () => (await read('open', 1))[0] ?? null,
    isActive: (row) => row.state.toLowerCase() === 'open',
    pageSize: BRANCH_PR_LOOKUP_PAGE_SIZE
  })
  // Branch lists paginate PRs, not their nested check contexts.
  return pr ? { ...pr, statusCheckRollup: [], checksUnavailable: true } : null
}

export async function hydrateBranchLookupWithExactPR(
  ownerRepo: OwnerRepo,
  branchData: PullRequestLookupData | null,
  ghOptions: GhExecOptions,
  executionScope: string,
  reads: PRProviderReadOptions = {}
): Promise<PullRequestLookupData | null> {
  if (!branchData) {
    return null
  }
  try {
    const exact = await getPRByNumber(
      ownerRepo,
      branchData.number,
      ghOptions,
      executionScope,
      branchData,
      reads
    )
    return exact ?? branchData
  } catch {
    return branchData
  }
}

export async function lookupPRByBranchName(args: {
  candidates: OwnerRepo[]
  headRepo: OwnerRepo | null
  branchName: string
  ghOptions: GhExecOptions
  executionScope: string
  policy?: PullRequestLookupPolicy
  reads?: PRProviderReadOptions
}): Promise<{
  data: PullRequestLookupData | null
  dataRepo: OwnerRepo | null
  pendingError?: unknown
}> {
  if (args.candidates.length > 0) {
    let pendingError: unknown
    let hasPendingError = false
    for (const candidate of args.candidates) {
      if (
        args.headRepo &&
        githubRepositoryWebHost(candidate).trim().toLowerCase() !==
          githubRepositoryWebHost(args.headRepo).trim().toLowerCase()
      ) {
        continue
      }
      try {
        const branchData = args.headRepo
          ? await getRestPRForBranch(
              candidate,
              args.headRepo.owner,
              args.branchName,
              args.ghOptions
            )
          : await getFallbackPRListForBranch(candidate, args.branchName, args.ghOptions)
        // Cheap branch discovery needs exact hydration for review, queue and auto-merge metadata.
        const data = await hydrateBranchLookupWithExactPR(
          candidate,
          branchData,
          args.ghOptions,
          args.executionScope,
          args.reads
        )
        if (
          data &&
          (!args.policy || (await args.policy.accepts(data, candidate))) &&
          pullRequestMatchesHeadRepository(data, candidate, args.headRepo)
        ) {
          return { data, dataRepo: candidate }
        }
      } catch (err) {
        if (args.headRepo) {
          throw err
        }
        if (!hasPendingError) {
          pendingError = err
          hasPendingError = true
        }
        try {
          const branchData = await getRestPRForBranch(
            candidate,
            candidate.owner,
            args.branchName,
            args.ghOptions
          )
          const data = await hydrateBranchLookupWithExactPR(
            candidate,
            branchData,
            args.ghOptions,
            args.executionScope,
            args.reads
          )
          if (
            data &&
            (!args.policy || (await args.policy.accepts(data, candidate))) &&
            pullRequestMatchesHeadRepository(data, candidate, args.headRepo)
          ) {
            return { data, dataRepo: candidate }
          }
        } catch (retryErr) {
          if (!hasPendingError) {
            pendingError = retryErr
            hasPendingError = true
          }
        }
      }
    }
    // Ambiguous fork-list failures still permit exact fallback-number recovery.
    return hasPendingError
      ? { data: null, dataRepo: null, pendingError }
      : { data: null, dataRepo: null }
  }

  try {
    noteRepositoryRateLimitSpend(null, 'graphql', 1, args.ghOptions)
    const { stdout } = await ghExecFileAsync(
      ['pr', 'view', args.branchName, '--json', PR_LOOKUP_JSON_FIELDS],
      args.ghOptions
    )
    const parsedData: PullRequestLookupData = JSON.parse(stdout)
    const repository = ownerRepoFromPullRequestUrl(parsedData.url)
    const data = repository
      ? await hydratePullRequestLookupData(
          repository,
          { ...parsedData, checksUnavailable: true },
          args.ghOptions,
          args.executionScope,
          args.reads
        )
      : {
          ...normalizePullRequestLookupData(parsedData),
          statusCheckRollup: [],
          checksUnavailable: true
        }
    const lookup = { data, dataRepo: null }
    return !args.policy || (await args.policy.accepts(lookup.data, null))
      ? lookup
      : { data: null, dataRepo: null }
  } catch (err) {
    if (isNoPullRequestError(err)) {
      return { data: null, dataRepo: null }
    }
    throw err
  }
}
