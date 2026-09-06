import type { CheckStatus } from '../../shared/github/pull-request-types'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import type { BitbucketAuthStatus } from './client'
import type { BitbucketPullRequestInfo } from './pull-request-mappers'
import type { BitbucketServerRepoRef } from './repository-ref'
import { getBitbucketServerConfig } from './server-config'
import {
  deriveBitbucketServerBuildStatus,
  mapBitbucketServerPullRequest,
  type RawBitbucketServerBuildStats,
  type RawBitbucketServerPullRequest
} from './server-pull-request-mappers'

const REQUEST_TIMEOUT_MS = 5000
const AUTH_PROBE_TIMEOUT_MS = 4000
const MAX_RATE_LIMIT_WAIT_MS = 3000

type RequestOptions = {
  searchParams?: Record<string, string>
  timeoutMs?: number
}

/** Data Center paginates with `start`/`limit` and reports `nextPageStart`. */
type RestPage<T> = {
  values?: T[]
  size?: number
  limit?: number
  isLastPage?: boolean
  nextPageStart?: number
}

function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function restUrl(baseUrl: string, path: string, searchParams?: RequestOptions['searchParams']) {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/rest${path}`)
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      url.searchParams.set(key, value)
    }
  }
  return url
}

/** Data Center returns `{ errors: [{ message }] }`, which beats a bare status. */
async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { errors?: { message?: string }[] }
    const message = body?.errors?.[0]?.message?.trim()
    if (message) {
      return message
    }
  } catch {
    // Why (orca#8695): a body left unread after a failed parse can crash the
    // process from inside undici. Fall through to the status-only message.
    await cancelUnreadResponseBody(response)
  }
  return `HTTP ${response.status}`
}

/**
 * Rate limiting is an admin-toggled filter that sits ahead of the REST layer,
 * so 429 can surface on any endpoint and is not declared in the API schema.
 */
function rateLimitWaitMs(response: Response): number | null {
  // Why: an absent header reads as `Number(null) === 0`, which would retry a
  // rate-limited request instantly. No header means no retry budget.
  const header = response.headers.get('retry-after')?.trim()
  if (!header) {
    return null
  }
  const seconds = Number(header)
  if (!Number.isFinite(seconds) || seconds < 0) {
    return null
  }
  const waitMs = seconds * 1000
  return waitMs <= MAX_RATE_LIMIT_WAIT_MS ? waitMs : null
}

async function requestJson<T>(
  baseUrl: string,
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
  const { token } = getBitbucketServerConfig()
  const url = restUrl(baseUrl, path, options.searchParams)
  try {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(url, {
        headers: { Accept: 'application/json', ...authHeaders(token) },
        signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS)
      })
      if (response.ok) {
        try {
          return (await response.json()) as T
        } catch (error) {
          // Why (orca#8695): a malformed success body can leave the stream
          // unread, which undici can turn into a process-level crash.
          await cancelUnreadResponseBody(response)
          throw error
        }
      }
      const retryAfterMs =
        attempt === 0 && response.status === 429 ? rateLimitWaitMs(response) : null
      if (retryAfterMs !== null) {
        await cancelUnreadResponseBody(response)
        const retryDelay = Promise.withResolvers<void>()
        setTimeout(retryDelay.resolve, retryAfterMs)
        await retryDelay.promise
        continue
      }
      if (response.status === 404 && notFoundIsNull) {
        await cancelUnreadResponseBody(response)
        return null
      }
      if (!throwOnFailure) {
        await cancelUnreadResponseBody(response)
        return null
      }
      throw new Error(`Bitbucket request failed: ${await errorMessage(response)}`)
    }
  } catch (error) {
    if (throwOnFailure) {
      throw error
    }
    return null
  }
}

function repoPath(repo: BitbucketServerRepoRef): string {
  return `/api/1.0/projects/${encodeURIComponent(repo.projectKey)}/repos/${encodeURIComponent(repo.repoSlug)}`
}

async function getBuildStatus(
  repo: BitbucketServerRepoRef,
  headSha: string | undefined
): Promise<CheckStatus> {
  if (!headSha) {
    return 'neutral'
  }
  const stats = await requestJson<RawBitbucketServerBuildStats>(
    repo.baseUrl,
    `/build-status/1.0/commits/stats/${encodeURIComponent(headSha)}`
  )
  return deriveBitbucketServerBuildStatus(stats)
}

export async function normalizeBitbucketServerPullRequest(
  repo: BitbucketServerRepoRef,
  raw: RawBitbucketServerPullRequest
): Promise<BitbucketPullRequestInfo | null> {
  const status = await getBuildStatus(repo, raw.fromRef?.latestCommit?.trim())
  return mapBitbucketServerPullRequest(raw, repo, status)
}

/**
 * `at` must be a fully-qualified ref, and `direction` defaults to INCOMING —
 * which would return the pull requests *targeting* the branch.
 *
 * Accepts either a short name or an already-qualified ref so callers cannot
 * silently produce `refs/heads/refs/heads/x`.
 */
export async function fetchBitbucketServerPullRequestForBranch(
  repo: BitbucketServerRepoRef,
  branchName: string,
  throwOnFailure = false
): Promise<RawBitbucketServerPullRequest | null> {
  const qualifiedRef = branchName.startsWith('refs/') ? branchName : `refs/heads/${branchName}`
  const page = await requestJson<RestPage<RawBitbucketServerPullRequest>>(
    repo.baseUrl,
    `${repoPath(repo)}/pull-requests`,
    {
      searchParams: {
        at: qualifiedRef,
        direction: 'OUTGOING',
        state: 'ALL',
        order: 'NEWEST',
        limit: '1',
        withAttributes: 'false',
        withProperties: 'false'
      }
    },
    throwOnFailure
  )
  return page?.values?.[0] ?? null
}

export function fetchBitbucketServerPullRequestById(
  repo: BitbucketServerRepoRef,
  prNumber: number,
  throwOnFailure = false,
  notFoundIsNull = false
): Promise<RawBitbucketServerPullRequest | null> {
  return requestJson<RawBitbucketServerPullRequest>(
    repo.baseUrl,
    `${repoPath(repo)}/pull-requests/${encodeURIComponent(String(prNumber))}`,
    {},
    throwOnFailure,
    notFoundIsNull
  )
}

/**
 * Data Center has no `/user` endpoint. `/users` is the documented
 * authenticated-only resource, and the username rides back on `X-AUSERNAME`.
 */
async function probeAuthenticatedAccount(
  baseUrl: string,
  token: string
): Promise<{ authenticated: boolean; account: string | null }> {
  try {
    const response = await fetch(restUrl(baseUrl, '/api/1.0/users', { limit: '1' }), {
      headers: { Accept: 'application/json', ...authHeaders(token) },
      signal: AbortSignal.timeout(AUTH_PROBE_TIMEOUT_MS)
    })
    await cancelUnreadResponseBody(response)
    if (!response.ok) {
      return { authenticated: false, account: null }
    }
    const rawAccount = response.headers.get('x-ausername')
    return {
      authenticated: true,
      account: rawAccount ? decodeURIComponent(rawAccount) : null
    }
  } catch {
    return { authenticated: false, account: null }
  }
}

export async function getBitbucketServerAuthStatus(): Promise<BitbucketAuthStatus> {
  const { baseUrl, token } = getBitbucketServerConfig()
  if (!baseUrl) {
    // Why: with no site URL there is no endpoint to probe — the base is
    // recovered per-repo from each `/scm/` remote. Reporting `configured` here
    // is a claim about configuration, not a verified session; a bad token
    // surfaces on the first real lookup. Mirrors getGiteaAuthStatus.
    return {
      configured: true,
      authenticated: true,
      account: null,
      baseUrl: null,
      tokenConfigured: true
    }
  }
  if (!token) {
    const properties = await requestJson<{ version?: string }>(
      baseUrl,
      '/api/1.0/application-properties',
      { timeoutMs: AUTH_PROBE_TIMEOUT_MS }
    )
    return {
      configured: properties !== null,
      authenticated: false,
      account: null,
      baseUrl,
      tokenConfigured: false
    }
  }
  const { authenticated, account } = await probeAuthenticatedAccount(baseUrl, token)
  return { configured: true, authenticated, account, baseUrl, tokenConfigured: true }
}
