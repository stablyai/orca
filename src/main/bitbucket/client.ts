import type { CheckStatus } from '../../shared/github/pull-request-types'
import {
  deriveBitbucketBuildStatus,
  mapBitbucketPullRequest,
  mapBitbucketPullRequestState,
  type BitbucketPullRequestInfo,
  type RawBitbucketBuildStatus,
  type RawBitbucketPullRequest
} from './pull-request-mappers'
import {
  getBitbucketRepoRef,
  getBitbucketRepoRefForRemote,
  type BitbucketRepoRef
} from './repository-ref'
import { shouldHideNonOpenReviewOnDefaultBranch } from '../source-control/repo-default-branch'
import {
  BRANCH_REVIEW_PAGE_SIZE,
  selectReviewForHead
} from '../source-control/branch-review-selection'
import { resolveBranchReviewTarget } from '../source-control/review-head'
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

function stateFilter(states: readonly string[]): string {
  return `(${states.map((state) => `state = "${state}"`).join(' OR ')})`
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
    const result = await fetchBitbucketUserResult(env)
    return {
      configured: true,
      // Why (STA-3944): only a rejection means the credential is bad. An
      // unreachable host must not render as "Auth failed" and send the user
      // off to regenerate a token that still works.
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

  const localGitOptions = getHostedReviewLocalGitOptions(options)
  const repo = await getBitbucketRepoRef(repoPath, connectionId, localGitOptions)
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

  // Why: a stale link falls back to the branch, so resolve its head as if unlinked.
  const { head } = await resolveBranchReviewTarget(
    repoPath,
    branchName,
    null,
    connectionId,
    localGitOptions
  )
  const headRepo = !head
    ? null
    : head.remote === 'origin'
      ? repo
      : await getBitbucketRepoRefForRemote(repoPath, head.remote, connectionId, localGitOptions)
  if (head && headRepo) {
    const headFullName = `${headRepo.workspace}/${headRepo.repoSlug}`
    const raw = await selectReviewForHead(
      async (states) => {
        const pullRequestStates = states === 'open' ? ['OPEN'] : ALL_PULL_REQUEST_STATES
        const list = await requestJson<{ values?: RawBitbucketPullRequest[] }>(
          `/repositories/${encodedRepoPath(repo)}/pullrequests`,
          {
            searchParams: {
              pagelen: String(BRANCH_REVIEW_PAGE_SIZE),
              sort: '-updated_on',
              // Why: `q=` drops Bitbucket's default open-only filter, so name every state.
              q: [
                `source.repository.full_name = "${escapeBitbucketQueryString(headFullName)}"`,
                `source.branch.name = "${escapeBitbucketQueryString(head.branch)}"`,
                stateFilter(pullRequestStates)
              ].join(' AND '),
              state: pullRequestStates
            }
          },
          throwOnFailure
        )
        return (list?.values ?? []).filter(
          (pr) => pr.source?.repository?.full_name?.toLowerCase() === headFullName.toLowerCase()
        )
      },
      (pr) => mapBitbucketPullRequestState(pr.state) === 'open'
    )
    if (raw) {
      // Why (#9171): discard a non-open implicit branch match on the repo default branch.
      const hideOnDefaultBranch = await shouldHideNonOpenReviewOnDefaultBranch({
        state: mapBitbucketPullRequestState(raw.state),
        reviewNumber: raw.id ?? null,
        linkedReviewNumber: linkedPRNumber,
        branchName,
        repoPath,
        connectionId,
        localGitOptions
      })
      if (!hideOnDefaultBranch) {
        return normalizePullRequest(repo, raw)
      }
    }
  }

  return null
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
