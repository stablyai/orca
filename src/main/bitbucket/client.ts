import type { CheckStatus } from '../../shared/github/pull-request-types'
import {
  deriveBitbucketBuildStatus,
  mapBitbucketPullRequest,
  mapBitbucketPullRequestState,
  type BitbucketPullRequestInfo,
  type RawBitbucketBuildStatus,
  type RawBitbucketPullRequest
} from './pull-request-mappers'
import { getBitbucketRepoRef, type BitbucketRepoRef } from './repository-ref'
import { shouldHideNonOpenReviewOnDefaultBranch } from '../source-control/repo-default-branch'
import {
  getHostedReviewLocalGitOptions,
  type HostedReviewExecutionOptions
} from '../source-control/hosted-review-git-options'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import { authHeaders, getEnvAuthConfig, hasAuth } from './bitbucket-auth-config'
import { accountNameFromUser, fetchBitbucketUserResult } from './user-request'
import {
  getStoredBitbucketCredentialError,
  getStoredBitbucketMetadata,
  hasStoredBitbucketCredential,
  loadStoredBitbucketSecret
} from './credential-store'
import { resolveBitbucketAuthConfig, storedAuthConfig } from './resolve-auth'

const REQUEST_TIMEOUT_MS = 5000
const ALL_PULL_REQUEST_STATES = ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'] as const

export type BitbucketAuthStatus = {
  configured: boolean
  authenticated: boolean
  account: string | null
}

type RequestOptions = {
  searchParams?: Record<string, string | readonly string[]>
  timeoutMs?: number
}

function isStringArray(value: string | readonly string[]): value is readonly string[] {
  return Array.isArray(value)
}

function apiUrl(
  baseUrl: string,
  path: string,
  searchParams?: RequestOptions['searchParams']
): string {
  const base = baseUrl.replace(/\/+$/, '')
  const url = new URL(`${base}${path}`)
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (isStringArray(value)) {
        for (const item of value) {
          url.searchParams.append(key, item)
        }
      } else {
        url.searchParams.set(key, value)
      }
    }
  }
  return url.toString()
}

async function requestJson<T>(
  path: string,
  options: RequestOptions = {},
  // Creation preflight must distinguish lookup failure from an absent PR.
  throwOnFailure = false,
  // A stale linked PR may 404 while the branch still has a review.
  notFoundIsNull = false
): Promise<T | null> {
  const config = resolveBitbucketAuthConfig()
  // Anonymous private-repo 404s must not be mistaken for an absent PR.
  if (!hasAuth(config)) {
    if (throwOnFailure) {
      throw new Error('Bitbucket request failed: no usable credential')
    }
    return null
  }
  try {
    const response = await fetch(apiUrl(config.baseUrl, path, options.searchParams), {
      headers: {
        Accept: 'application/json',
        ...authHeaders(config)
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS)
    })
    if (!response.ok) {
      await cancelUnreadResponseBody(response)
      if (response.status === 404 && notFoundIsNull) {
        return null
      }
      if (throwOnFailure) {
        throw new Error(`Bitbucket request failed: HTTP ${response.status}`)
      }
      return null
    }
    return (await response.json()) as T
  } catch (error) {
    if (throwOnFailure) {
      throw error
    }
    return null
  }
}

function encodedRepoPath(repo: BitbucketRepoRef): string {
  return `${encodeURIComponent(repo.workspace)}/${encodeURIComponent(repo.repoSlug)}`
}

function escapeBitbucketQueryString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function allStateFilter(): string {
  return `(${ALL_PULL_REQUEST_STATES.map((state) => `state = "${state}"`).join(' OR ')})`
}

async function getBuildStatus(
  repo: BitbucketRepoRef,
  headSha: string | undefined
): Promise<CheckStatus> {
  if (!headSha) {
    return 'neutral'
  }
  const data = await requestJson<{ values?: RawBitbucketBuildStatus[] }>(
    `/repositories/${encodedRepoPath(repo)}/commit/${encodeURIComponent(headSha)}/statuses/build`,
    { searchParams: { pagelen: '100' } }
  )
  return deriveBitbucketBuildStatus(data?.values ?? [])
}

async function normalizePullRequest(
  repo: BitbucketRepoRef,
  raw: RawBitbucketPullRequest
): Promise<BitbucketPullRequestInfo | null> {
  const headSha = raw.source?.commit?.hash?.trim()
  const status = await getBuildStatus(repo, headSha)
  return mapBitbucketPullRequest(raw, status)
}

// Avoid keychain prompts: validate stored credentials only when the secret is already cached.
export async function getBitbucketAuthStatus(): Promise<BitbucketAuthStatus> {
  const env = getEnvAuthConfig()
  if (hasAuth(env)) {
    const result = await fetchBitbucketUserResult(env)
    return {
      configured: true,
      // An unreachable host does not prove the credential is invalid.
      authenticated: result.ok || result.reason === 'unreachable',
      account: result.ok ? accountNameFromUser(result.user) : null
    }
  }
  const metadata = getStoredBitbucketMetadata()
  if (metadata && hasStoredBitbucketCredential()) {
    if (getStoredBitbucketCredentialError()) {
      return { configured: true, authenticated: false, account: metadata.account }
    }
    const cached = loadStoredBitbucketSecret()
    if (!cached) {
      return { configured: true, authenticated: true, account: metadata.account }
    }
    const result = await fetchBitbucketUserResult(storedAuthConfig(metadata, cached))
    return {
      configured: true,
      authenticated: result.ok || result.reason === 'unreachable',
      account: (result.ok ? accountNameFromUser(result.user) : null) ?? metadata.account
    }
  }
  return { configured: false, authenticated: false, account: null }
}

export async function getBitbucketPullRequest(
  repoPath: string,
  prNumber: number,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<BitbucketPullRequestInfo | null> {
  const repo = await getBitbucketRepoRef(
    repoPath,
    connectionId,
    getHostedReviewLocalGitOptions(options)
  )
  if (!repo) {
    return null
  }
  const raw = await requestJson<RawBitbucketPullRequest>(
    `/repositories/${encodedRepoPath(repo)}/pullrequests/${encodeURIComponent(String(prNumber))}`
  )
  return raw ? normalizePullRequest(repo, raw) : null
}

export async function getBitbucketPullRequestForBranch(
  repoPath: string,
  branch: string,
  linkedPRNumber?: number | null,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {},
  throwOnFailure = false
): Promise<BitbucketPullRequestInfo | null> {
  const branchName = branch.replace(/^refs\/heads\//, '')
  if (!branchName && linkedPRNumber == null) {
    return null
  }

  const repo = await getBitbucketRepoRef(
    repoPath,
    connectionId,
    getHostedReviewLocalGitOptions(options)
  )
  if (!repo) {
    return null
  }

  if (typeof linkedPRNumber === 'number') {
    const raw = await requestJson<RawBitbucketPullRequest>(
      `/repositories/${encodedRepoPath(repo)}/pullrequests/${encodeURIComponent(String(linkedPRNumber))}`,
      {},
      throwOnFailure,
      true
    )
    if (raw) {
      return normalizePullRequest(repo, raw)
    }
  }

  if (branchName) {
    const query = [
      `source.branch.name = "${escapeBitbucketQueryString(branchName)}"`,
      allStateFilter()
    ].join(' AND ')
    const list = await requestJson<{ values?: RawBitbucketPullRequest[] }>(
      `/repositories/${encodedRepoPath(repo)}/pullrequests`,
      {
        searchParams: {
          pagelen: '1',
          sort: '-updated_on',
          q: query,
          state: ALL_PULL_REQUEST_STATES
        }
      },
      throwOnFailure
    )
    const raw = list?.values?.[0]
    if (raw) {
      const state = mapBitbucketPullRequestState(raw.state)
      // Exclude implicit merged matches so they cannot block a new PR on the branch.
      const isMergedImplicitMatch = state === 'merged'
      const hideOnDefaultBranch = await shouldHideNonOpenReviewOnDefaultBranch({
        state,
        reviewNumber: raw.id ?? null,
        linkedReviewNumber: linkedPRNumber,
        branchName,
        repoPath,
        connectionId,
        localGitOptions: getHostedReviewLocalGitOptions(options)
      })
      if (!isMergedImplicitMatch && !hideOnDefaultBranch) {
        return normalizePullRequest(repo, raw)
      }
    }
  }

  return null
}

/** Preserve lookup failures so creation preflight can report review state as unavailable. */
export function getBitbucketPullRequestForBranchOrThrow(
  repoPath: string,
  branch: string,
  linkedPRNumber?: number | null,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<BitbucketPullRequestInfo | null> {
  return getBitbucketPullRequestForBranch(
    repoPath,
    branch,
    linkedPRNumber,
    connectionId,
    options,
    true
  )
}

export async function getBitbucketRepoSlug(
  repoPath: string,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<BitbucketRepoRef | null> {
  return getBitbucketRepoRef(repoPath, connectionId, getHostedReviewLocalGitOptions(options))
}
