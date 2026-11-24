import {
  deriveGiteaCommitStatus,
  mapGiteaPullRequest,
  mapGiteaPullRequestState,
  type GiteaPullRequestInfo,
  type RawGiteaCombinedStatus,
  type RawGiteaPullRequest
} from './pull-request-mappers'
import { shouldHideNonOpenReviewOnDefaultBranch } from '../source-control/repo-default-branch'
import { getGiteaRepoRef, type GiteaRepoRef } from './repository-ref'
import { invalidateGiteaPullRequestScan, scanGiteaPullRequests } from './pull-request-scan-cache'
import {
  getHostedReviewLocalGitOptions,
  type HostedReviewExecutionOptions
} from '../source-control/hosted-review-git-options'
import {
  getEnvGiteaAuth,
  giteaGetJsonAtBase,
  resolveGiteaAuth,
  type GiteaReadOptions
} from './requests/gitea-request'
import { getServerTokens } from './servers/gitea-server-store'

const REQUEST_TIMEOUT_MS = 5000
// Forgejo may spend several seconds loading reviewers for one pulls page.
const PULL_REQUEST_LIST_TIMEOUT_MS = 15_000
const PULL_REQUEST_PAGE_LIMIT = 50
const MAX_PULL_REQUEST_PAGES = 5

export type GiteaAuthStatus = {
  configured: boolean
  authenticated: boolean
  account: string | null
  baseUrl: string | null
  tokenConfigured: boolean
}

type RequestOptions = Omit<GiteaReadOptions, 'token'>

// Reads go through the shared Gitea reader: env credentials first, then a server saved for this host.
async function requestJson<T>(
  repo: GiteaRepoRef,
  path: string,
  options: RequestOptions = {},
  // Creation needs transport/auth failures distinguished from confirmed absence.
  throwOnFailure = false
): Promise<T | null> {
  const auth = await resolveGiteaAuth(repo)
  return giteaGetJsonAtBase<T>(
    auth.apiBaseUrl,
    path,
    { timeoutMs: REQUEST_TIMEOUT_MS, ...options, token: auth.token },
    throwOnFailure
  )
}

function configuredApiBaseUrl(repo: GiteaRepoRef): string {
  return getEnvGiteaAuth().apiBaseUrl ?? repo.apiBaseUrl
}

function encodedRepoPath(repo: GiteaRepoRef): string {
  return `${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`
}

function giteaPullRequestScanKey(repo: GiteaRepoRef): string {
  return `${configuredApiBaseUrl(repo)}/${encodedRepoPath(repo)}`
}

/** Invalidate after creation so card refreshes cannot reuse a cached miss. */
export function invalidateGiteaPullRequestScanForRepo(repo: GiteaRepoRef): void {
  const repoKey = giteaPullRequestScanKey(repo)
  invalidateGiteaPullRequestScan(repoKey)
  invalidateGiteaPullRequestScan(`${repoKey}::strict`)
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
  const env = getEnvGiteaAuth()
  const tokenConfigured = env.token !== null
  if (!env.apiBaseUrl && !tokenConfigured) {
    return savedServerAuthStatus()
  }
  if (!env.apiBaseUrl) {
    return { configured: true, authenticated: true, account: null, baseUrl: null, tokenConfigured }
  }
  if (!tokenConfigured) {
    const version = await giteaGetJsonAtBase<{ version?: string }>(env.apiBaseUrl, '/version', {
      timeoutMs: 4000
    })
    return {
      configured: version !== null,
      authenticated: false,
      account: null,
      baseUrl: env.apiBaseUrl,
      tokenConfigured
    }
  }
  const user = await giteaGetJsonAtBase<{
    login?: string | null
    username?: string | null
    full_name?: string | null
  }>(env.apiBaseUrl, '/user', { timeoutMs: 4000, token: env.token })
  return {
    configured: true,
    authenticated: user !== null,
    account: user?.login ?? user?.username ?? user?.full_name ?? null,
    baseUrl: env.apiBaseUrl,
    tokenConfigured
  }
}

// Servers connected in Settings authenticate when their token was verified at connect time.
async function savedServerAuthStatus(): Promise<GiteaAuthStatus> {
  const saved = await getServerTokens().catch(() => [])
  const first = saved[0]?.server
  return first
    ? {
        configured: true,
        authenticated: true,
        account: first.account,
        baseUrl: first.baseUrl,
        tokenConfigured: true
      }
    : {
        configured: false,
        authenticated: false,
        account: null,
        baseUrl: null,
        tokenConfigured: false
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
  options: HostedReviewExecutionOptions = {},
  throwOnFailure = false
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
    const pullRequests = await scanGiteaPullRequests(
      // Strict scans must not inherit an empty result produced by a failed lenient scan.
      throwOnFailure ? `${giteaPullRequestScanKey(repo)}::strict` : giteaPullRequestScanKey(repo),
      (page) =>
        requestJson<RawGiteaPullRequest[]>(
          repo,
          `/repos/${encodedRepoPath(repo)}/pulls`,
          {
            searchParams: {
              state: 'all',
              sort: 'recentupdate',
              page,
              limit: PULL_REQUEST_PAGE_LIMIT
            },
            timeoutMs: PULL_REQUEST_LIST_TIMEOUT_MS
          },
          throwOnFailure
        ),
      PULL_REQUEST_PAGE_LIMIT,
      MAX_PULL_REQUEST_PAGES
    )
    const raw = pullRequests.find((item) => matchesBranch(item, branchName))
    if (raw) {
      const hideOnDefaultBranch = await shouldHideNonOpenReviewOnDefaultBranch({
        state: mapGiteaPullRequestState(raw),
        reviewNumber: raw.number ?? null,
        linkedReviewNumber: linkedPRNumber,
        branchName,
        repoPath,
        connectionId,
        localGitOptions: getHostedReviewLocalGitOptions(options)
      })
      if (!hideOnDefaultBranch) {
        return normalizePullRequest(repo, raw)
      }
    }
  }

  if (typeof linkedPRNumber !== 'number') {
    return null
  }
  const raw = await requestJson<RawGiteaPullRequest>(
    repo,
    `/repos/${encodedRepoPath(repo)}/pulls/${encodeURIComponent(String(linkedPRNumber))}`,
    { allowNotFound: true },
    throwOnFailure
  )
  return raw ? normalizePullRequest(repo, raw) : null
}

/** Surface lookup failures as unavailable rather than a false missing review. */
export function getGiteaPullRequestForBranchOrThrow(
  repoPath: string,
  branch: string,
  linkedPRNumber?: number | null,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<GiteaPullRequestInfo | null> {
  return getGiteaPullRequestForBranch(repoPath, branch, linkedPRNumber, connectionId, options, true)
}

export async function getGiteaRepoSlug(
  repoPath: string,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<GiteaRepoRef | null> {
  return getGiteaRepoRef(repoPath, connectionId, getHostedReviewLocalGitOptions(options))
}
