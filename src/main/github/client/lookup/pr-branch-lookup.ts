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
export async function getRestPRForBranch(
  prRepo: GitHubApiRepository,
  headOwner: string,
  branchName: string,
  ghOptions: ReturnType<typeof ghRepoExecOptions>
): Promise<PullRequestLookupData | null> {
  const head = encodeURIComponent(`${headOwner}:${branchName}`)
  const stdout = await revalidateGitHubRestJson(
    prRepo,
    `repos/${prRepo.owner}/${prRepo.repo}/pulls?head=${head}&state=all&per_page=1`,
    ghOptions
  )
  const list = JSON.parse(stdout) as RestPullRequest[]
  const pr = list[0]
  return pr ? mapRestPullRequest(pr) : null
}

export async function getFallbackPRListForBranch(
  prRepo: GitHubApiRepository,
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
      '1',
      '--json',
      PR_BRANCH_LIST_JSON_FIELDS
    ],
    { ...ghOptions, ...githubHostExecOptions(prRepo) }
  )
  const list = JSON.parse(stdout) as PullRequestLookupData[]
  return list[0] ?? null
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
