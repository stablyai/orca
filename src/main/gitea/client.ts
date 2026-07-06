import {
  deriveGiteaCommitStatus,
  mapGiteaPullRequest,
  type GiteaPullRequestInfo,
  type RawGiteaCombinedStatus,
  type RawGiteaPullRequest
} from './pull-request-mappers'
import { getGiteaRepoRef, type GiteaRepoRef } from './repository-ref'
import {
  getHostedReviewLocalGitOptions,
  type HostedReviewExecutionOptions
} from '../source-control/hosted-review-git-options'
import { getEnvGiteaAuth, resolveGiteaAuth, type GiteaAuthConfig } from './project-config'

const REQUEST_TIMEOUT_MS = 5000
const PULL_REQUEST_PAGE_LIMIT = 50
const MAX_PULL_REQUEST_PAGES = 5

export type GiteaAuthStatus = {
  configured: boolean
  authenticated: boolean
  account: string | null
  baseUrl: string | null
  tokenConfigured: boolean
}

type RequestOptions = {
  searchParams?: Record<string, string | number>
  timeoutMs?: number
  auth?: GiteaAuthConfig
}

export function normalizeGiteaApiBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  return /\/api\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/api/v1`
}

function authHeaders(config: Pick<GiteaAuthConfig, 'token'>): Record<string, string> {
  return config.token ? { Authorization: `token ${config.token}` } : {}
}

function configuredApiBaseUrl(repo: GiteaRepoRef, auth: GiteaAuthConfig): string {
  return auth.apiBaseUrl ?? repo.apiBaseUrl
}

function apiUrl(baseUrl: string, path: string, searchParams?: RequestOptions['searchParams']): URL {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}${path}`)
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      url.searchParams.set(key, String(value))
    }
  }
  return url
}

async function requestJsonAtBase<T>(
  baseUrl: string,
  path: string,
  options: RequestOptions = {}
): Promise<T | null> {
  const auth = options.auth ?? getEnvGiteaAuth()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(apiUrl(baseUrl, path, options.searchParams), {
      headers: {
        Accept: 'application/json',
        ...authHeaders(auth)
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
  repo: GiteaRepoRef,
  path: string,
  options: RequestOptions = {}
): Promise<T | null> {
  const auth = options.auth ?? getEnvGiteaAuth()
  return requestJsonAtBase(configuredApiBaseUrl(repo, auth), path, options)
}

function encodedRepoPath(repo: GiteaRepoRef): string {
  return `${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`
}

async function getCommitStatus(
  repo: GiteaRepoRef,
  headSha: string | undefined,
  auth?: GiteaAuthConfig
): Promise<ReturnType<typeof deriveGiteaCommitStatus>> {
  if (!headSha) {
    return 'neutral'
  }
  const data = await requestJson<RawGiteaCombinedStatus>(
    repo,
    `/repos/${encodedRepoPath(repo)}/commits/${encodeURIComponent(headSha)}/status`,
    auth ? { auth } : {}
  )
  return deriveGiteaCommitStatus(data)
}

async function normalizePullRequest(
  repo: GiteaRepoRef,
  raw: RawGiteaPullRequest,
  auth?: GiteaAuthConfig
): Promise<GiteaPullRequestInfo | null> {
  const status = await getCommitStatus(repo, raw.head?.sha?.trim(), auth)
  return mapGiteaPullRequest(raw, status)
}

function matchesBranch(raw: RawGiteaPullRequest, branchName: string): boolean {
  const ref = raw.head?.ref?.trim()
  if (ref === branchName) {
    return true
  }
  const label = raw.head?.label?.trim()
  return label === branchName || label?.endsWith(`:${branchName}`) === true
}

export async function getGiteaAuthStatus(repoPath?: string): Promise<GiteaAuthStatus> {
  const config = repoPath ? await resolveGiteaAuth(repoPath) : getEnvGiteaAuth()
  const tokenConfigured = config.token !== null
  if (!config.apiBaseUrl && !tokenConfigured) {
    return {
      configured: false,
      authenticated: false,
      account: null,
      baseUrl: null,
      tokenConfigured: false
    }
  }
  if (!config.apiBaseUrl) {
    return {
      configured: true,
      authenticated: true,
      account: null,
      baseUrl: null,
      tokenConfigured
    }
  }

  if (!tokenConfigured) {
    const version = await requestJsonAtBase<{ version?: string }>(config.apiBaseUrl, '/version', {
      timeoutMs: 4000,
      auth: config
    })
    return {
      configured: version !== null,
      authenticated: false,
      account: null,
      baseUrl: config.apiBaseUrl,
      tokenConfigured
    }
  }

  const user = await requestJsonAtBase<{
    login?: string | null
    username?: string | null
    full_name?: string | null
  }>(config.apiBaseUrl, '/user', { timeoutMs: 4000, auth: config })
  return {
    configured: true,
    authenticated: user !== null,
    account: user?.login ?? user?.username ?? user?.full_name ?? null,
    baseUrl: config.apiBaseUrl,
    tokenConfigured
  }
}

export async function getGiteaPullRequest(
  repoPath: string,
  prNumber: number,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<GiteaPullRequestInfo | null> {
  const repo = await getGiteaRepoRef(
    repoPath,
    connectionId,
    getHostedReviewLocalGitOptions(options)
  )
  if (!repo) {
    return null
  }
  const auth = await resolveGiteaAuth(repoPath)
  const raw = await requestJson<RawGiteaPullRequest>(
    repo,
    `/repos/${encodedRepoPath(repo)}/pulls/${encodeURIComponent(String(prNumber))}`,
    { auth }
  )
  return raw ? normalizePullRequest(repo, raw, auth) : null
}

export async function getGiteaPullRequestForBranch(
  repoPath: string,
  branch: string,
  linkedPRNumber?: number | null,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<GiteaPullRequestInfo | null> {
  const branchName = branch.replace(/^refs\/heads\//, '')
  if (!branchName && linkedPRNumber == null) {
    return null
  }

  const repo = await getGiteaRepoRef(
    repoPath,
    connectionId,
    getHostedReviewLocalGitOptions(options)
  )
  if (!repo) {
    return null
  }

  const auth = await resolveGiteaAuth(repoPath)

  if (branchName) {
    for (let page = 1; page <= MAX_PULL_REQUEST_PAGES; page++) {
      const list = await requestJson<RawGiteaPullRequest[]>(
        repo,
        `/repos/${encodedRepoPath(repo)}/pulls`,
        {
          searchParams: {
            state: 'all',
            sort: 'recentupdate',
            page,
            limit: PULL_REQUEST_PAGE_LIMIT
          },
          auth
        }
      )
      const raw = list?.find((item) => matchesBranch(item, branchName))
      if (raw) {
        return normalizePullRequest(repo, raw, auth)
      }
      if (!list || list.length < PULL_REQUEST_PAGE_LIMIT) {
        break
      }
    }
  }

  if (typeof linkedPRNumber !== 'number') {
    return null
  }
  const raw = await requestJson<RawGiteaPullRequest>(
    repo,
    `/repos/${encodedRepoPath(repo)}/pulls/${encodeURIComponent(String(linkedPRNumber))}`,
    { auth }
  )
  return raw ? normalizePullRequest(repo, raw, auth) : null
}

export async function getGiteaRepoSlug(
  repoPath: string,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<GiteaRepoRef | null> {
  return getGiteaRepoRef(repoPath, connectionId, getHostedReviewLocalGitOptions(options))
}
