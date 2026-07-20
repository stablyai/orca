import {
  deriveAzureDevOpsStatus,
  mapAzureDevOpsPullRequest,
  type AzureDevOpsPullRequestInfo,
  type RawAzureDevOpsPullRequest,
  type RawAzureDevOpsStatus
} from './pull-request-mappers'
import { getAzureDevOpsRepoRef, type AzureDevOpsRepoRef } from './repository-ref'
import {
  getHostedReviewLocalGitOptions,
  type HostedReviewExecutionOptions
} from '../source-control/hosted-review-git-options'
import {
  azureDevOpsTokenConfigured,
  getAzureDevOpsAuthConfig,
  normalizeAzureDevOpsApiBaseUrl,
  requestAzureDevOpsJson,
  requestAzureDevOpsJsonAtBase
} from './azure-devops-api-request'
export { normalizeAzureDevOpsApiBaseUrl } from './azure-devops-api-request'

export type AzureDevOpsAuthStatus = {
  configured: boolean
  authenticated: boolean
  account: string | null
  baseUrl: string | null
  tokenConfigured: boolean
}

type RawAzureDevOpsRepository = {
  id?: string | null
  name?: string | null
  webUrl?: string | null
  _links?: {
    web?: {
      href?: string | null
    } | null
  } | null
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value)
}

async function getRepository(
  repo: AzureDevOpsRepoRef
): Promise<{ idOrName: string; webBaseUrl: string } | null> {
  const raw = await requestAzureDevOpsJson<RawAzureDevOpsRepository>(
    repo,
    `/_apis/git/repositories/${encodePathSegment(repo.repository)}`
  )
  if (!raw) {
    return { idOrName: repo.repository, webBaseUrl: repo.webBaseUrl }
  }
  return {
    idOrName: raw.id?.trim() || repo.repository,
    webBaseUrl: raw.webUrl ?? raw._links?.web?.href ?? repo.webBaseUrl
  }
}

function readStatusList(
  raw: RawAzureDevOpsStatus[] | { value?: RawAzureDevOpsStatus[] } | null
): RawAzureDevOpsStatus[] {
  if (Array.isArray(raw)) {
    return raw
  }
  return raw?.value ?? []
}

async function getPullRequestStatuses(
  repo: AzureDevOpsRepoRef,
  repoIdOrName: string,
  pr: RawAzureDevOpsPullRequest
): Promise<RawAzureDevOpsStatus[]> {
  const raw = await requestAzureDevOpsJson<
    RawAzureDevOpsStatus[] | { value?: RawAzureDevOpsStatus[] }
  >(
    repo,
    `/_apis/git/repositories/${encodePathSegment(repoIdOrName)}/pullRequests/${encodePathSegment(
      String(pr.pullRequestId)
    )}/statuses`
  )
  const prStatuses = readStatusList(raw)
  if (prStatuses.length > 0) {
    return prStatuses
  }
  const commitId = pr.lastMergeSourceCommit?.commitId?.trim()
  if (!commitId) {
    return pr.statuses ?? []
  }
  const commitStatuses = await requestAzureDevOpsJson<
    RawAzureDevOpsStatus[] | { value?: RawAzureDevOpsStatus[] }
  >(
    repo,
    `/_apis/git/repositories/${encodePathSegment(repoIdOrName)}/commits/${encodePathSegment(
      commitId
    )}/statuses`
  )
  return readStatusList(commitStatuses)
}

async function normalizePullRequest(
  repo: AzureDevOpsRepoRef,
  repoIdOrName: string,
  webBaseUrl: string,
  raw: RawAzureDevOpsPullRequest
): Promise<AzureDevOpsPullRequestInfo | null> {
  const statuses = await getPullRequestStatuses(repo, repoIdOrName, raw)
  return mapAzureDevOpsPullRequest(raw, deriveAzureDevOpsStatus(statuses), webBaseUrl)
}

function sortPullRequestsForBranch(
  left: RawAzureDevOpsPullRequest,
  right: RawAzureDevOpsPullRequest
): number {
  const leftStatus = left.status?.trim().toLowerCase()
  const rightStatus = right.status?.trim().toLowerCase()
  const abandonedOrder = Number(leftStatus === 'abandoned') - Number(rightStatus === 'abandoned')
  // Why: abandoned PRs can have newer close dates, but should not hide a usable branch PR.
  if (abandonedOrder !== 0) {
    return abandonedOrder
  }
  const leftTime = Date.parse(left.closedDate ?? left.creationDate ?? '') || 0
  const rightTime = Date.parse(right.closedDate ?? right.creationDate ?? '') || 0
  if (leftTime !== rightTime) {
    return rightTime - leftTime
  }
  return Number(rightStatus === 'active') - Number(leftStatus === 'active')
}

export async function getAzureDevOpsAuthStatus(): Promise<AzureDevOpsAuthStatus> {
  const config = getAzureDevOpsAuthConfig()
  const baseUrl = config.apiBaseUrl ? normalizeAzureDevOpsApiBaseUrl(config.apiBaseUrl) : null
  const hasToken = azureDevOpsTokenConfigured(config)
  if (!baseUrl && !hasToken) {
    return {
      configured: false,
      authenticated: false,
      account: null,
      baseUrl: null,
      tokenConfigured: false
    }
  }
  if (!baseUrl) {
    return {
      configured: true,
      authenticated: false,
      account: null,
      baseUrl: null,
      tokenConfigured: hasToken
    }
  }

  const connection = await requestAzureDevOpsJsonAtBase<{
    authenticatedUser?: {
      providerDisplayName?: string | null
      customDisplayName?: string | null
      uniqueName?: string | null
    } | null
  }>(baseUrl, '/_apis/connectionData', { timeoutMs: 4000 })
  const user = connection?.authenticatedUser
  return {
    configured: hasToken || connection !== null,
    authenticated: connection !== null && (hasToken || user !== null),
    account: user?.providerDisplayName ?? user?.customDisplayName ?? user?.uniqueName ?? null,
    baseUrl,
    tokenConfigured: hasToken
  }
}

export async function getAzureDevOpsPullRequest(
  repoPath: string,
  prNumber: number,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<AzureDevOpsPullRequestInfo | null> {
  const repo = await getAzureDevOpsRepoRef(
    repoPath,
    connectionId,
    getHostedReviewLocalGitOptions(options)
  )
  const repository = repo ? await getRepository(repo) : null
  if (!repo || !repository) {
    return null
  }
  const raw = await requestAzureDevOpsJson<RawAzureDevOpsPullRequest>(
    repo,
    `/_apis/git/repositories/${encodePathSegment(repository.idOrName)}/pullRequests/${encodePathSegment(
      String(prNumber)
    )}`
  )
  return raw ? normalizePullRequest(repo, repository.idOrName, repository.webBaseUrl, raw) : null
}

export async function getAzureDevOpsPullRequestForBranch(
  repoPath: string,
  branch: string,
  linkedPRNumber?: number | null,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {},
  throwOnFailure = false
): Promise<AzureDevOpsPullRequestInfo | null> {
  const branchName = branch.replace(/^refs\/heads\//, '')
  if (!branchName && linkedPRNumber == null) {
    return null
  }

  const repo = await getAzureDevOpsRepoRef(
    repoPath,
    connectionId,
    getHostedReviewLocalGitOptions(options)
  )
  const repository = repo ? await getRepository(repo) : null
  if (!repo || !repository) {
    return null
  }

  if (branchName) {
    const list = await requestAzureDevOpsJson<{ value?: RawAzureDevOpsPullRequest[] }>(
      repo,
      `/_apis/git/repositories/${encodePathSegment(repository.idOrName)}/pullRequests`,
      {
        searchParams: {
          'searchCriteria.sourceRefName': `refs/heads/${branchName}`,
          'searchCriteria.status': 'all',
          $top: 10
        }
      },
      throwOnFailure
    )
    const raw = (list?.value ?? []).sort(sortPullRequestsForBranch)[0]
    if (raw) {
      return normalizePullRequest(repo, repository.idOrName, repository.webBaseUrl, raw)
    }
  }

  if (typeof linkedPRNumber !== 'number') {
    return null
  }
  const raw = await requestAzureDevOpsJson<RawAzureDevOpsPullRequest>(
    repo,
    `/_apis/git/repositories/${encodePathSegment(repository.idOrName)}/pullRequests/${encodePathSegment(
      String(linkedPRNumber)
    )}`,
    {},
    throwOnFailure
  )
  return raw ? normalizePullRequest(repo, repository.idOrName, repository.webBaseUrl, raw) : null
}

/**
 * Existing-review lookup that surfaces transport/auth failures instead of
 * collapsing them to null, so a failed lookup becomes
 * `reviewLookupOutcome: 'unavailable'` rather than a false "No pull request found".
 */
export function getAzureDevOpsPullRequestForBranchOrThrow(
  repoPath: string,
  branch: string,
  linkedPRNumber?: number | null,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<AzureDevOpsPullRequestInfo | null> {
  return getAzureDevOpsPullRequestForBranch(
    repoPath,
    branch,
    linkedPRNumber,
    connectionId,
    options,
    true
  )
}

export async function getAzureDevOpsRepoSlug(
  repoPath: string,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<AzureDevOpsRepoRef | null> {
  return getAzureDevOpsRepoRef(repoPath, connectionId, getHostedReviewLocalGitOptions(options))
}
