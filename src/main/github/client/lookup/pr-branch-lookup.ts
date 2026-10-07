import { ghExecFileAsync } from '../../gh-utils'
import type { OwnerRepo, ghRepoExecOptions } from '../../gh-utils'
import { githubHostExecOptions, type GitHubApiRepository } from '../../github-api-repository'
import type { GhExecOptions } from './../github-exec-scope'
import { isNoPullRequestError } from './../gh-error-predicates'
import {
  PR_LOOKUP_JSON_FIELDS,
  PR_BRANCH_LIST_JSON_FIELDS,
  mapRestPullRequest,
  normalizePullRequestLookupData,
  type PullRequestLookupData,
  type RestPullRequest
} from './pull-request-lookup-data'
import { getPRByNumber } from './pr-number-lookup'
export async function getRestPRForBranch(
  prRepo: GitHubApiRepository,
  headOwner: string,
  branchName: string,
  ghOptions: ReturnType<typeof ghRepoExecOptions>
): Promise<PullRequestLookupData | null> {
  const head = encodeURIComponent(`${headOwner}:${branchName}`)
  const { stdout } = await ghExecFileAsync(
    ['api', `repos/${prRepo.owner}/${prRepo.repo}/pulls?head=${head}&state=all&per_page=1`],
    { ...ghOptions, ...githubHostExecOptions(prRepo) }
  )
  const list = JSON.parse(stdout) as RestPullRequest[]
  const pr = list[0]
  return pr ? mapRestPullRequest(pr) : null
}

export async function getFallbackPRListForBranch(
  prRepo: GitHubApiRepository,
  headOwner: string | null,
  branchName: string,
  ghOptions: ReturnType<typeof ghRepoExecOptions>,
  headOid?: string | null
): Promise<{ data: PullRequestLookupData; headRepo: GitHubApiRepository } | null> {
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
  const headMatches = headOwner
    ? list.filter((pr) => pr.headRepositoryOwner?.login?.toLowerCase() === headOwner.toLowerCase())
    : headOid
      ? list.filter((pr) => pr.headRefOid?.toLowerCase() === headOid.toLowerCase())
      : []
  const match = headOwner
    ? (headMatches[0] ?? null)
    : headMatches.length === 1
      ? headMatches[0]
      : null
  const actualHeadOwner = match?.headRepositoryOwner?.login
  if (!match || !actualHeadOwner) {
    return null
  }
  return {
    data: match,
    // Why: PR details belong to the base repo, but branch tracking belongs to its actual fork.
    headRepo: { ...prRepo, owner: actualHeadOwner }
  }
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
  currentHeadOid?: string | null
  ghOptions: GhExecOptions
  executionScope: string
}): Promise<{
  data: PullRequestLookupData | null
  dataRepo: OwnerRepo | null
  dataHeadRepo: GitHubApiRepository | null
  pendingError?: unknown
}> {
  if (args.candidates.length > 0) {
    let pendingError: unknown
    let hasPendingError = false
    for (const candidate of args.candidates) {
      try {
        let dataHeadRepo = args.headRepo
        let branchData: PullRequestLookupData | null
        if (args.headRepo) {
          branchData = await getRestPRForBranch(
            candidate,
            args.headRepo.owner,
            args.branchName,
            args.ghOptions
          )
        } else {
          const fallback = await getFallbackPRListForBranch(
            candidate,
            candidate.owner,
            args.branchName,
            args.ghOptions
          )
          branchData = fallback?.data ?? null
          dataHeadRepo = fallback?.headRepo ?? null
        }
        if (!branchData && args.headRepo && args.headRepoInferred && args.currentHeadOid) {
          // Why: origin may be canonical while a same-name branch PR lives on a separately named fork.
          try {
            const fallback = await getFallbackPRListForBranch(
              candidate,
              null,
              args.branchName,
              args.ghOptions,
              args.currentHeadOid
            )
            branchData = fallback?.data ?? null
            dataHeadRepo = fallback?.headRepo ?? null
          } catch (err) {
            if (!hasPendingError) {
              pendingError = err
              hasPendingError = true
            }
          }
        }
        // Why: REST/list branch lookup identifies the PR cheaply; exact `gh pr view` carries review, merge-queue, and auto-merge state.
        const data = await hydrateBranchLookupWithExactPR(
          candidate,
          branchData,
          args.ghOptions,
          args.executionScope
        )
        if (data) {
          return { data, dataRepo: candidate, dataHeadRepo }
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
          const dataHeadRepo = candidate
          const data = await hydrateBranchLookupWithExactPR(
            candidate,
            branchData,
            args.ghOptions,
            args.executionScope
          )
          if (data) {
            return { data, dataRepo: candidate, dataHeadRepo }
          }
        } catch (retryErr) {
          if (!hasPendingError) {
            pendingError = retryErr
            hasPendingError = true
          }
        }
      }
    }
    // Why: branch-list failures are ambiguous for fork discovery; give exact fallback-number recovery a chance before surfacing the error.
    return hasPendingError
      ? { data: null, dataRepo: null, dataHeadRepo: null, pendingError }
      : { data: null, dataRepo: null, dataHeadRepo: null }
  }

  try {
    const { stdout } = await ghExecFileAsync(
      ['pr', 'view', args.branchName, '--json', PR_LOOKUP_JSON_FIELDS],
      args.ghOptions
    )
    return {
      data: normalizePullRequestLookupData(JSON.parse(stdout) as PullRequestLookupData),
      dataRepo: null,
      dataHeadRepo: null
    }
  } catch (err) {
    if (isNoPullRequestError(err)) {
      return { data: null, dataRepo: null, dataHeadRepo: null }
    }
    throw err
  }
}
