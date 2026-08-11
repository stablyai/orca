import type { CheckStatus } from '../../shared/types'
import {
  deriveBitbucketBuildStatus,
  mapBitbucketPullRequest,
  mapBitbucketPullRequestState,
  type BitbucketPullRequestInfo,
  type RawBitbucketBuildStatus,
  type RawBitbucketPullRequest
} from './pull-request-mappers'
import { getBitbucketRepoRef, type BitbucketRepoRef } from './repository-ref'
import {
  getHostedReviewLocalGitOptions,
  type HostedReviewExecutionOptions
} from '../source-control/hosted-review-git-options'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import { authHeaders, getEnvAuthConfig, hasAuth } from './bitbucket-auth-config'
import { accountNameFromUser, fetchBitbucketUser } from './user-request'
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
  // Why: the existing-review lookup behind Create must distinguish a real
  // transport/auth failure from an accepted "no PR". When true, a failed request
  // throws instead of collapsing to null so callers never report false not_found.
  throwOnFailure = false
): Promise<T | null> {
  const config = resolveBitbucketAuthConfig()
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

// Never decrypts. Env credentials are checked live; a stored credential is
// revalidated only when its secret already sits in memory from an earlier API
// call, and otherwise trusted from plaintext metadata — decrypting here would
// prompt for keychain access every time Settings opens.
export async function getBitbucketAuthStatus(): Promise<BitbucketAuthStatus> {
  const env = getEnvAuthConfig()
  if (hasAuth(env)) {
    const user = await fetchBitbucketUser(env)
    return {
      configured: true,
      authenticated: user !== null,
      account: accountNameFromUser(user)
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
    const user = await fetchBitbucketUser(storedAuthConfig(metadata, cached))
    return {
      configured: true,
      authenticated: user !== null,
      account: accountNameFromUser(user) ?? metadata.account
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
      // Why: a merged or declined PR we only matched by branch name is history,
      // not review context — the same rule GitHub applies. Keeping it would
      // report "a pull request already exists" and block the branch's next PR.
      // An explicitly linked review still resolves through the fallback below.
      const isImplicitNonOpenMatch =
        mapBitbucketPullRequestState(raw.state) !== 'open' &&
        !(typeof linkedPRNumber === 'number' && raw.id === linkedPRNumber)
      if (!isImplicitNonOpenMatch) {
        return normalizePullRequest(repo, raw)
      }
    }
  }

  if (typeof linkedPRNumber !== 'number') {
    return null
  }
  const raw = await requestJson<RawBitbucketPullRequest>(
    `/repositories/${encodedRepoPath(repo)}/pullrequests/${encodeURIComponent(String(linkedPRNumber))}`,
    {},
    throwOnFailure
  )
  return raw ? normalizePullRequest(repo, raw) : null
}

/**
 * Existing-review lookup that surfaces transport/auth failures instead of
 * collapsing them to null. The hosted-review creation preflight uses this so a
 * failed lookup becomes `reviewLookupOutcome: 'unavailable'`, never a false
 * "No pull request found".
 */
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
