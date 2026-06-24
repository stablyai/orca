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
import {
  getAuthConfig,
  normalizeGiteaApiBaseUrl,
  requestJsonAtBase,
  requestJson,
  encodedRepoPath
} from './request'

export { normalizeGiteaApiBaseUrl }

const PULL_REQUEST_PAGE_LIMIT = 50
const MAX_PULL_REQUEST_PAGES = 5

export type GiteaAuthStatus = {
  configured: boolean
  authenticated: boolean
  account: string | null
  baseUrl: string | null
  tokenConfigured: boolean
}

async function getCommitStatus(
  repo: GiteaRepoRef,
  headSha: string | undefined
): Promise<ReturnType<typeof deriveGiteaCommitStatus>> {
  if (!headSha) {
    return 'neutral'
  }
  const data = await requestJson<RawGiteaCombinedStatus>(
    repo,
    `/repos/${encodedRepoPath(repo)}/commits/${encodeURIComponent(headSha)}/status`
  )
  return deriveGiteaCommitStatus(data)
}

async function normalizePullRequest(
  repo: GiteaRepoRef,
  raw: RawGiteaPullRequest
): Promise<GiteaPullRequestInfo | null> {
  const status = await getCommitStatus(repo, raw.head?.sha?.trim())
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

export async function getGiteaAuthStatus(): Promise<GiteaAuthStatus> {
  const config = getAuthConfig()
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
      timeoutMs: 4000
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
  }>(config.apiBaseUrl, '/user', { timeoutMs: 4000 })
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
  const raw = await requestJson<RawGiteaPullRequest>(
    repo,
    `/repos/${encodedRepoPath(repo)}/pulls/${encodeURIComponent(String(prNumber))}`
  )
  return raw ? normalizePullRequest(repo, raw) : null
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
          }
        }
      )
      const raw = list?.find((item) => matchesBranch(item, branchName))
      if (raw) {
        return normalizePullRequest(repo, raw)
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
    `/repos/${encodedRepoPath(repo)}/pulls/${encodeURIComponent(String(linkedPRNumber))}`
  )
  return raw ? normalizePullRequest(repo, raw) : null
}

export async function getGiteaRepoSlug(
  repoPath: string,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<GiteaRepoRef | null> {
  return getGiteaRepoRef(repoPath, connectionId, getHostedReviewLocalGitOptions(options))
}
