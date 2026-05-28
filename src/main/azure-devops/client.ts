import { Buffer } from 'buffer'
import {
  deriveAzureDevOpsStatus,
  mapAzureDevOpsPullRequest,
  type AzureDevOpsPullRequestInfo,
  type RawAzureDevOpsPullRequest,
  type RawAzureDevOpsStatus
} from './pull-request-mappers'
import { getAzureDevOpsRepoRef, type AzureDevOpsRepoRef } from './repository-ref'

const REQUEST_TIMEOUT_MS = 5000

type AzureDevOpsAuthConfig = {
  apiBaseUrl: string | null
  pat: string | null
  accessToken: string | null
  username: string | null
}

export type AzureDevOpsAuthStatus = {
  configured: boolean
  authenticated: boolean
  account: string | null
  baseUrl: string | null
  tokenConfigured: boolean
}

type RequestOptions = {
  searchParams?: Record<string, string | number>
  timeoutMs?: number
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

function envValue(name: string): string | null {
  const value = process.env[name]?.trim() ?? ''
  return value.length > 0 ? value : null
}

export function normalizeAzureDevOpsApiBaseUrl(value: string): string {
  return value
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/_apis$/i, '')
}

function getAuthConfig(): AzureDevOpsAuthConfig {
  return {
    apiBaseUrl: envValue('ORCA_AZURE_DEVOPS_API_BASE_URL'),
    pat: envValue('ORCA_AZURE_DEVOPS_TOKEN') ?? envValue('ORCA_AZURE_DEVOPS_PAT'),
    accessToken: envValue('ORCA_AZURE_DEVOPS_ACCESS_TOKEN'),
    username: envValue('ORCA_AZURE_DEVOPS_USERNAME')
  }
}

function tokenConfigured(config: AzureDevOpsAuthConfig): boolean {
  return Boolean(config.pat || config.accessToken)
}

function authHeaders(config: AzureDevOpsAuthConfig): Record<string, string> {
  if (config.accessToken) {
    return { Authorization: `Bearer ${config.accessToken}` }
  }
  if (config.pat) {
    const encoded = Buffer.from(`${config.username ?? ''}:${config.pat}`).toString('base64')
    return { Authorization: `Basic ${encoded}` }
  }
  return {}
}

function configuredApiBaseUrl(repo: AzureDevOpsRepoRef): string {
  const configured = getAuthConfig().apiBaseUrl
  return configured ? normalizeAzureDevOpsApiBaseUrl(configured) : repo.apiBaseUrl
}

function apiUrl(baseUrl: string, path: string, searchParams?: RequestOptions['searchParams']): URL {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}${path}`)
  const params = { ...searchParams, 'api-version': searchParams?.['api-version'] ?? '7.1' }
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value))
  }
  return url
}

async function requestJsonAtBase<T>(
  baseUrl: string,
  path: string,
  options: RequestOptions = {}
): Promise<T | null> {
  const config = getAuthConfig()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(apiUrl(baseUrl, path, options.searchParams), {
      headers: {
        Accept: 'application/json',
        ...authHeaders(config)
      },
      signal: controller.signal
    })
    if (!response.ok) {
      return null
    }
    return (await response.json()) as T
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

function requestJson<T>(
  repo: AzureDevOpsRepoRef,
  path: string,
  options: RequestOptions = {}
): Promise<T | null> {
  return requestJsonAtBase(configuredApiBaseUrl(repo), path, options)
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value)
}

async function getRepository(
  repo: AzureDevOpsRepoRef
): Promise<{ idOrName: string; webBaseUrl: string } | null> {
  const raw = await requestJson<RawAzureDevOpsRepository>(
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
  const raw = await requestJson<RawAzureDevOpsStatus[] | { value?: RawAzureDevOpsStatus[] }>(
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
  const commitStatuses = await requestJson<
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
  const leftTime = Date.parse(left.closedDate ?? left.creationDate ?? '') || 0
  const rightTime = Date.parse(right.closedDate ?? right.creationDate ?? '') || 0
  if (leftTime !== rightTime) {
    return rightTime - leftTime
  }
  const leftActive = left.status?.trim().toLowerCase() === 'active'
  const rightActive = right.status?.trim().toLowerCase() === 'active'
  if (leftActive !== rightActive) {
    return leftActive ? -1 : 1
  }
  return 0
}

export async function getAzureDevOpsAuthStatus(): Promise<AzureDevOpsAuthStatus> {
  const config = getAuthConfig()
  const baseUrl = config.apiBaseUrl ? normalizeAzureDevOpsApiBaseUrl(config.apiBaseUrl) : null
  const hasToken = tokenConfigured(config)
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

  const connection = await requestJsonAtBase<{
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
  prNumber: number
): Promise<AzureDevOpsPullRequestInfo | null> {
  const repo = await getAzureDevOpsRepoRef(repoPath)
  if (!repo) {
    return null
  }
  const repository = await getRepository(repo)
  if (!repository) {
    return null
  }
  const raw = await requestJson<RawAzureDevOpsPullRequest>(
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
  linkedPRNumber?: number | null
): Promise<AzureDevOpsPullRequestInfo | null> {
  const branchName = branch.replace(/^refs\/heads\//, '')
  if (!branchName && linkedPRNumber == null) {
    return null
  }

  const repo = await getAzureDevOpsRepoRef(repoPath)
  if (!repo) {
    return null
  }
  const repository = await getRepository(repo)
  if (!repository) {
    return null
  }

  if (branchName) {
    const list = await requestJson<{ value?: RawAzureDevOpsPullRequest[] }>(
      repo,
      `/_apis/git/repositories/${encodePathSegment(repository.idOrName)}/pullRequests`,
      {
        searchParams: {
          'searchCriteria.sourceRefName': `refs/heads/${branchName}`,
          'searchCriteria.status': 'all',
          $top: 10
        }
      }
    )
    const raw = (list?.value ?? []).sort(sortPullRequestsForBranch)[0]
    if (raw) {
      return normalizePullRequest(repo, repository.idOrName, repository.webBaseUrl, raw)
    }
  }

  if (typeof linkedPRNumber !== 'number') {
    return null
  }
  const raw = await requestJson<RawAzureDevOpsPullRequest>(
    repo,
    `/_apis/git/repositories/${encodePathSegment(repository.idOrName)}/pullRequests/${encodePathSegment(
      String(linkedPRNumber)
    )}`
  )
  return raw ? normalizePullRequest(repo, repository.idOrName, repository.webBaseUrl, raw) : null
}

export async function getAzureDevOpsRepoSlug(repoPath: string): Promise<AzureDevOpsRepoRef | null> {
  return getAzureDevOpsRepoRef(repoPath)
}
