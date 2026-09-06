import type { CheckStatus } from '../../shared/github/pull-request-types'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import type { BitbucketAuthStatus } from './client'
import {
  deriveBitbucketBuildStatus,
  mapBitbucketPullRequest,
  type BitbucketPullRequestInfo,
  type RawBitbucketBuildStatus,
  type RawBitbucketPullRequest
} from './pull-request-mappers'
import type { BitbucketCloudRepoRef } from './repository-ref'
import { authHeaders, envValue, getEnvAuthConfig, hasAuth } from './bitbucket-auth-config'
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

type RequestOptions = {
  searchParams?: Record<string, string | readonly string[]>
  timeoutMs?: number
}

/** Only an explicitly overridden base URL is worth reporting; the Cloud default is noise. */
function baseUrlOverride(): string | null {
  return envValue('ORCA_BITBUCKET_API_BASE_URL')
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
      if (Array.isArray(value)) {
        for (const item of value) {
          url.searchParams.append(key, item)
        }
      } else {
        url.searchParams.set(key, value as string)
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
  throwOnFailure = false,
  // Why: a linked PR number can be stale (deleted PR, wrong repo). A 404 there
  // must fall through to the branch lookup rather than throw and hide the
  // branch's real review, so only that caller opts into it.
  notFoundIsNull = false
): Promise<T | null> {
  const config = resolveBitbucketAuthConfig()
  // Why: a denied keychain prompt leaves no usable credential. Issuing the
  // request anyway gets a 404 on private repos, which reads as "no pull
  // request" and offers Create for a branch that already has one.
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
    try {
      return (await response.json()) as T
    } catch (error) {
      // Why (orca#8695): a malformed success body can leave the stream unread,
      // which undici can turn into a process-level crash.
      await cancelUnreadResponseBody(response)
      throw error
    }
  } catch (error) {
    if (throwOnFailure) {
      throw error
    }
    return null
  }
}

function encodedRepoPath(repo: BitbucketCloudRepoRef): string {
  return `${encodeURIComponent(repo.workspace)}/${encodeURIComponent(repo.repoSlug)}`
}

async function getBuildStatus(
  repo: BitbucketCloudRepoRef,
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

export async function normalizeBitbucketCloudPullRequest(
  repo: BitbucketCloudRepoRef,
  raw: RawBitbucketPullRequest
): Promise<BitbucketPullRequestInfo | null> {
  const status = await getBuildStatus(repo, raw.source?.commit?.hash?.trim())
  return mapBitbucketPullRequest(raw, status)
}

export async function fetchBitbucketCloudPullRequestForBranch(
  repo: BitbucketCloudRepoRef,
  branchName: string,
  throwOnFailure: boolean
): Promise<RawBitbucketPullRequest | null> {
  const escapedBranch = branchName.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const stateFilter = ALL_PULL_REQUEST_STATES.map((state) => `state = "${state}"`).join(' OR ')
  const list = await requestJson<{ values?: RawBitbucketPullRequest[] }>(
    `/repositories/${encodedRepoPath(repo)}/pullrequests`,
    {
      searchParams: {
        pagelen: '1',
        sort: '-updated_on',
        q: `source.branch.name = "${escapedBranch}" AND (${stateFilter})`,
        state: ALL_PULL_REQUEST_STATES
      }
    },
    throwOnFailure
  )
  return list?.values?.[0] ?? null
}

export function fetchBitbucketCloudPullRequestById(
  repo: BitbucketCloudRepoRef,
  prNumber: number,
  throwOnFailure: boolean,
  notFoundIsNull = false
): Promise<RawBitbucketPullRequest | null> {
  return requestJson<RawBitbucketPullRequest>(
    `/repositories/${encodedRepoPath(repo)}/pullrequests/${encodeURIComponent(String(prNumber))}`,
    {},
    throwOnFailure,
    notFoundIsNull
  )
}

/** Cloud is usable with an access token or the email + API-token pair, from the
 *  environment or a credential saved in Orca. Presence only — never decrypts, so
 *  the Data Center tie-break cannot trigger a keychain prompt. */
export function hasCloudCredentials(): boolean {
  return hasAuth(getEnvAuthConfig()) || hasStoredBitbucketCredential()
}

// Never decrypts. Env credentials are checked live; a stored credential is
// revalidated only when its secret already sits in memory from an earlier API
// call, and otherwise trusted from plaintext metadata — decrypting here would
// prompt for keychain access every time Settings opens.
export async function getBitbucketCloudAuthStatus(): Promise<BitbucketAuthStatus> {
  const override = baseUrlOverride()
  const env = getEnvAuthConfig()
  if (hasAuth(env)) {
    const result = await fetchBitbucketUserResult(env)
    return {
      configured: true,
      // Why (STA-3944): only a rejection means the credential is bad. An
      // unreachable host must not render as "Auth failed" and send the user
      // off to regenerate a token that still works.
      authenticated: result.ok || result.reason === 'unreachable',
      account: result.ok ? accountNameFromUser(result.user) : null,
      baseUrl: override,
      tokenConfigured: true
    }
  }
  const metadata = getStoredBitbucketMetadata()
  if (metadata && hasStoredBitbucketCredential()) {
    const stored = { baseUrl: metadata.baseUrl ?? override, tokenConfigured: true }
    if (getStoredBitbucketCredentialError()) {
      return { configured: true, authenticated: false, account: metadata.account, ...stored }
    }
    const cached = loadStoredBitbucketSecret()
    if (!cached) {
      return { configured: true, authenticated: true, account: metadata.account, ...stored }
    }
    const result = await fetchBitbucketUserResult(storedAuthConfig(metadata, cached))
    return {
      configured: true,
      authenticated: result.ok || result.reason === 'unreachable',
      account: (result.ok ? accountNameFromUser(result.user) : null) ?? metadata.account,
      ...stored
    }
  }
  return {
    configured: false,
    authenticated: false,
    account: null,
    baseUrl: null,
    tokenConfigured: false
  }
}
