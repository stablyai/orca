import { ghExecFileAsync } from '../../gh-utils'
import type { OwnerRepo, ghRepoExecOptions } from '../../gh-utils'
import {
  githubHostExecOptions,
  githubRepositoryWebHost,
  type GitHubApiRepository
} from '../../github-api-repository'
import type { GhExecOptions } from './../github-exec-scope'
import { isNoPullRequestError } from './../gh-error-predicates'
import {
  PR_LOOKUP_JSON_FIELDS,
  PR_BRANCH_LIST_JSON_FIELDS,
  mapRestPullRequest,
  normalizePullRequestLookupData,
  pullRequestMatchesHeadRepository,
  type PullRequestLookupData,
  type PullRequestLookupPolicy,
  type RestPullRequest
} from './pull-request-lookup-data'
import { getPRByNumber } from './pr-number-lookup'
import { revalidateGitHubRestJson } from '../../github-rest-revalidation'
import { noteRepositoryRateLimitSpend } from '../../rate-limit'

// Why: GitHub lists a branch's PRs newest first, so with a page of one a closed PR opened after
// the live one wins. Fetch a page and prefer the open PR; fall back to the newest one.
const BRANCH_PR_LOOKUP_PAGE_SIZE = 10

function preferOpenPullRequest<T extends { state: string }>(list: T[]): T | undefined {
  return list.find((pr) => pr.state.toLowerCase() === 'open') ?? list[0]
}

export async function getRestPRForBranch(
  prRepo: GitHubApiRepository,
  headOwner: string,
  branchName: string,
  ghOptions: ReturnType<typeof ghRepoExecOptions>
): Promise<PullRequestLookupData | null> {
  const head = encodeURIComponent(`${headOwner}:${branchName}`)
  const stdout = await revalidateGitHubRestJson(
    prRepo,
    `repos/${prRepo.owner}/${prRepo.repo}/pulls?head=${head}&state=all&per_page=${BRANCH_PR_LOOKUP_PAGE_SIZE}`,
    ghOptions
  )
  const list = JSON.parse(stdout) as RestPullRequest[]
  const pr = preferOpenPullRequest(list)
  return pr ? mapRestPullRequest(pr) : null
}

export async function getFallbackPRListForBranch(
  prRepo: GitHubApiRepository,
  headOwner: string,
  branchName: string,
  ghOptions: ReturnType<typeof ghRepoExecOptions>
): Promise<PullRequestLookupData | null> {
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
      'all',
      '--limit',
      '100',
      '--json',
      PR_BRANCH_LIST_JSON_FIELDS
    ],
    { ...ghOptions, ...githubHostExecOptions(prRepo) }
  )
  const list = JSON.parse(stdout) as (PullRequestLookupData & {
    headRepositoryOwner?: { login?: string } | null
  })[]
  return (
    list.find((pr) => pr.headRepositoryOwner?.login?.toLowerCase() === headOwner.toLowerCase()) ??
    null
  )
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

export async function lookupPRByBranchName(args: {
  candidates: OwnerRepo[]
  headRepo: OwnerRepo | null
  headRepoInferred: boolean
  branchName: string
  ghOptions: GhExecOptions
  executionScope: string
  policy?: PullRequestLookupPolicy
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
        let branchData = args.headRepo
          ? await getRestPRForBranch(
              candidate,
              args.headRepo.owner,
              args.branchName,
              args.ghOptions
            )
          : await getFallbackPRListForBranch(
              candidate,
              candidate.owner,
              args.branchName,
              args.ghOptions
            )
        if (!branchData && args.headRepo && args.headRepoInferred) {
          // Why: an inferred fork owner can return no REST match even when the branch already has a PR.
          try {
            branchData = await getFallbackPRListForBranch(
              candidate,
              args.headRepo.owner,
              args.branchName,
              args.ghOptions
            )
          } catch (err) {
            if (!hasPendingError) {
              pendingError = err
              hasPendingError = true
            }
          }
        }
        // Cheap branch discovery needs exact hydration for review, queue and auto-merge metadata.
        const data = await hydrateBranchLookupWithExactPR(
          candidate,
          branchData,
          args.ghOptions,
          args.executionScope
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
            args.executionScope
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
    const lookup = {
      data: normalizePullRequestLookupData(JSON.parse(stdout) as PullRequestLookupData),
      dataRepo: null
    }
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
