import { classifyPRRefreshError } from '../../pull-requests/refresh/pr-refresh-error-classification'
import { ghExecFileAsync } from '../../../git/command-runner/hosted-cli/gh-exec-file'
import type {
  GitHubRepositoryIdentity as OwnerRepo,
  GitHubRepositoryIdentity as GitHubApiRepository
} from '../../../../shared/github/repositories/repository-identity'
import type { ghRepoExecOptions } from '../../repositories/github-repository-identity'
import { githubHostExecOptions } from '../../repositories/github-repository-host'

import {
  isNoPullRequestError,
  isNotFoundGhError,
  shouldStopAfterExactLookupError
} from './../gh-error-predicates'
import {
  PR_LOOKUP_JSON_FIELDS,
  normalizePullRequestLookupData,
  mapRestPullRequest,
  type PullRequestLookupData,
  type PullRequestLookupPolicy,
  type RestPullRequest
} from './pull-request-lookup-data'
import { hydratePullRequestLookupData } from './pull-request-lookup-hydration'
import { isGitObjectId, isUsableRestStackMetadata } from './rest-stack-metadata-validation'
import { revalidateGitHubRestJson } from '../../api/github-rest-revalidation'
import { noteRepositoryRateLimitSpend } from '../../api/rate-limit'
import { ownerRepoFromPullRequestUrl, sameOwnerRepo } from '../github-exec-scope'
import {
  readSharedPullRequestSidebarQuery,
  type PRProviderReadOptions
} from './shared-pr-provider-reads'
export async function getRestPRByNumber(
  ownerRepo: GitHubApiRepository,
  number: number,
  ghOptions: ReturnType<typeof ghRepoExecOptions>,
  options: { requireUsableStackMetadata?: boolean } = {}
): Promise<PullRequestLookupData> {
  const stdout = await revalidateGitHubRestJson(
    ownerRepo,
    `repos/${ownerRepo.owner}/${ownerRepo.repo}/pulls/${number}`,
    ghOptions
  )
  const parsed = JSON.parse(stdout) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('invalid response shape')
  }
  const restData = parsed as RestPullRequest
  const mapped = mapRestPullRequest(restData)
  if (
    options.requireUsableStackMetadata &&
    restData.stack !== undefined &&
    restData.stack !== null
  ) {
    // Absent stack metadata is valid; malformed non-null metadata is unsafe.
    if (!isUsableRestStackMetadata(restData.stack) || !mapped.stack) {
      throw new Error('malformed stack')
    }
    if (!isGitObjectId(restData.head?.sha)) {
      throw new Error('missing head SHA')
    }
  }
  return mapped
}

export async function getPRByNumber(
  ownerRepo: GitHubApiRepository,
  number: number,
  ghOptions: ReturnType<typeof ghRepoExecOptions>,
  executionScope: string,
  knownPullRequestData?: PullRequestLookupData | null,
  options: { includeStackSummary?: boolean } & PRProviderReadOptions = {}
): Promise<PullRequestLookupData | null> {
  const reads = { checkPageLimit: options.checkPageLimit, userRefresh: options.userRefresh }
  try {
    let sidebarData: Awaited<ReturnType<typeof readSharedPullRequestSidebarQuery>>
    try {
      sidebarData =
        options.includeStackSummary || knownPullRequestData !== undefined
          ? await readSharedPullRequestSidebarQuery(
              ownerRepo,
              number,
              ghOptions,
              executionScope,
              reads
            )
          : undefined
    } catch (error) {
      if (
        !knownPullRequestData ||
        ['repo_unavailable', 'permission', 'rate_limited', 'auth'].includes(
          classifyPRRefreshError(error)
        )
      ) {
        throw error
      }
      // Optional combined reads retain the exact metadata recovery path.
      sidebarData = undefined
    }
    if (sidebarData === null) {
      return null
    }
    if (sidebarData) {
      const { stack, ...prData } = sidebarData
      const known = knownPullRequestData
      const sameIdentity =
        known &&
        known.number === number &&
        sameOwnerRepo(ownerRepoFromPullRequestUrl(known.url), ownerRepo) &&
        known.headRepositoryOwner?.login?.toLowerCase() ===
          prData.headRepositoryOwner?.login?.toLowerCase() &&
        known.headRepository?.name?.toLowerCase() === prData.headRepository?.name?.toLowerCase()
      const compatibleStack =
        sameIdentity &&
        known.headRefOid === prData.headRefOid &&
        known.baseRefOid === prData.baseRefOid &&
        stack &&
        known.stack?.number === stack.number &&
        known.stack.position === stack.position &&
        known.stack.baseRefName === stack.baseRefName
          ? { ...known.stack, ...stack }
          : stack
      const hydrated = await hydratePullRequestLookupData(
        ownerRepo,
        {
          ...prData,
          ...(sameIdentity && known.headDefaultBranchName
            ? { headDefaultBranchName: known.headDefaultBranchName }
            : {})
        },
        ghOptions,
        executionScope,
        reads
      )
      return { ...hydrated, ...(compatibleStack ? { stack: compatibleStack } : {}) }
    }
    noteRepositoryRateLimitSpend(ownerRepo, 'graphql', 1, ghOptions)
    const { stdout } = await ghExecFileAsync(
      [
        'pr',
        'view',
        String(number),
        '--repo',
        `${ownerRepo.owner}/${ownerRepo.repo}`,
        '--json',
        PR_LOOKUP_JSON_FIELDS
      ],
      { ...ghOptions, ...githubHostExecOptions(ownerRepo) }
    )
    const exactData = JSON.parse(stdout) as PullRequestLookupData
    return await hydratePullRequestLookupData(
      ownerRepo,
      {
        ...knownPullRequestData,
        ...exactData,
        checksUnavailable: true,
        ...(knownPullRequestData?.stack ? { stack: knownPullRequestData.stack } : {})
      },
      ghOptions,
      executionScope,
      reads
    )
  } catch (err) {
    // Missing links return to branch discovery; other failures get one cheaper REST recovery lookup.
    if (isNotFoundGhError(err)) {
      return null
    }
    try {
      const restData =
        knownPullRequestData === undefined
          ? await getRestPRByNumber(ownerRepo, number, ghOptions)
          : knownPullRequestData
      return restData
        ? await hydratePullRequestLookupData(
            ownerRepo,
            { ...restData, checksUnavailable: true },
            ghOptions,
            executionScope,
            reads
          )
        : null
    } catch (restErr) {
      if (isNotFoundGhError(restErr)) {
        return null
      }
      if (!shouldStopAfterExactLookupError(restErr)) {
        return null
      }
      throw restErr
    }
  }
}

export async function lookupPRByNumber(args: {
  candidates: OwnerRepo[]
  number: number
  ghOptions: ReturnType<typeof ghRepoExecOptions>
  executionScope: string
  policy?: PullRequestLookupPolicy
  reads?: PRProviderReadOptions
}): Promise<{ data: PullRequestLookupData | null; dataRepo: OwnerRepo | null }> {
  for (const candidate of args.candidates) {
    if (args.policy?.isRejected(candidate, args.number)) {
      continue
    }
    try {
      const linkedData = await getPRByNumber(
        candidate,
        args.number,
        args.ghOptions,
        args.executionScope,
        undefined,
        { includeStackSummary: true, ...args.reads }
      )
      if (!linkedData || (args.policy && !(await args.policy.accepts(linkedData, candidate)))) {
        continue
      }
      return { data: linkedData, dataRepo: candidate }
    } catch (err) {
      if (shouldStopAfterExactLookupError(err)) {
        throw err
      }
      // Candidate probing is best-effort; another repo may own the PR.
    }
  }

  if (args.candidates.length > 0) {
    return { data: null, dataRepo: null }
  }

  try {
    noteRepositoryRateLimitSpend(null, 'graphql', 1, args.ghOptions)
    const { stdout } = await ghExecFileAsync(
      ['pr', 'view', String(args.number), '--json', PR_LOOKUP_JSON_FIELDS],
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
      // Stale fallback numbers can refer to deleted PRs or another repository.
      return { data: null, dataRepo: null }
    }
    throw err
  }
}
