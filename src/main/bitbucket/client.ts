import {
  fetchBitbucketCloudPullRequestById,
  fetchBitbucketCloudPullRequestForBranch,
  getBitbucketCloudAuthStatus,
  hasCloudCredentials,
  normalizeBitbucketCloudPullRequest
} from './cloud-client'
import {
  mapBitbucketPullRequestState,
  type BitbucketPullRequestInfo,
  type RawBitbucketPullRequest
} from './pull-request-mappers'
import { shouldHideNonOpenReviewOnDefaultBranch } from '../source-control/repo-default-branch'
import {
  getBitbucketRepoRef,
  type BitbucketCloudRepoRef,
  type BitbucketRepoRef,
  type BitbucketServerRepoRef
} from './repository-ref'
import {
  getHostedReviewLocalGitOptions,
  type HostedReviewExecutionOptions
} from '../source-control/hosted-review-git-options'
import { getBitbucketServerConfig } from './server-config'
import {
  fetchBitbucketServerPullRequestById,
  fetchBitbucketServerPullRequestForBranch,
  getBitbucketServerAuthStatus,
  normalizeBitbucketServerPullRequest
} from './server-client'
import {
  mapBitbucketServerPullRequestState,
  type RawBitbucketServerPullRequest
} from './server-pull-request-mappers'

export type BitbucketAuthStatus = {
  configured: boolean
  authenticated: boolean
  account: string | null
  /** Data Center site base URL, or the Cloud API override when one is set. */
  baseUrl: string | null
  tokenConfigured: boolean
}

/** Raw payload paired with the ref that produced it, so the Cloud and Data
 *  Center shapes stay type-safe through the shared lookup flow. */
type PullRequestCandidate =
  | { kind: 'cloud'; repo: BitbucketCloudRepoRef; raw: RawBitbucketPullRequest }
  | { kind: 'server'; repo: BitbucketServerRepoRef; raw: RawBitbucketServerPullRequest }

function normalizeCandidate(
  candidate: PullRequestCandidate
): Promise<BitbucketPullRequestInfo | null> {
  return candidate.kind === 'server'
    ? normalizeBitbucketServerPullRequest(candidate.repo, candidate.raw)
    : normalizeBitbucketCloudPullRequest(candidate.repo, candidate.raw)
}

function candidateState(candidate: PullRequestCandidate): BitbucketPullRequestInfo['state'] {
  return candidate.kind === 'server'
    ? mapBitbucketServerPullRequestState(candidate.raw.state)
    : mapBitbucketPullRequestState(candidate.raw.state)
}

async function fetchCandidateForBranch(
  repo: BitbucketRepoRef,
  branchName: string,
  throwOnFailure: boolean
): Promise<PullRequestCandidate | null> {
  if (repo.kind === 'server') {
    const raw = await fetchBitbucketServerPullRequestForBranch(repo, branchName, throwOnFailure)
    return raw ? { kind: 'server', repo, raw } : null
  }
  const raw = await fetchBitbucketCloudPullRequestForBranch(repo, branchName, throwOnFailure)
  return raw ? { kind: 'cloud', repo, raw } : null
}

async function fetchCandidateById(
  repo: BitbucketRepoRef,
  prNumber: number,
  throwOnFailure: boolean,
  notFoundIsNull = false
): Promise<PullRequestCandidate | null> {
  if (repo.kind === 'server') {
    const raw = await fetchBitbucketServerPullRequestById(
      repo,
      prNumber,
      throwOnFailure,
      notFoundIsNull
    )
    return raw ? { kind: 'server', repo, raw } : null
  }
  const raw = await fetchBitbucketCloudPullRequestById(
    repo,
    prNumber,
    throwOnFailure,
    notFoundIsNull
  )
  return raw ? { kind: 'cloud', repo, raw } : null
}

export function getBitbucketAuthStatus(): Promise<BitbucketAuthStatus> {
  const serverConfig = getBitbucketServerConfig()
  // Why: preflight carries one Bitbucket status, so a deployment has to win.
  // A configured site URL is an unambiguous "I run Data Center" and takes it.
  // A bare token is not: it is enough for `/scm/` remotes, but on its own it
  // must not silently displace a fully configured Cloud account — a stray
  // ORCA_BITBUCKET_SERVER_TOKEN would blank the card of a working Cloud setup.
  // An unconfigured install falls to Cloud, which reports "not configured".
  const serverWins =
    serverConfig.baseUrl !== null || (serverConfig.token !== null && !hasCloudCredentials())
  return serverWins ? getBitbucketServerAuthStatus() : getBitbucketCloudAuthStatus()
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
  const candidate = await fetchCandidateById(repo, prNumber, false)
  return candidate ? normalizeCandidate(candidate) : null
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
    const candidate = await fetchCandidateById(repo, linkedPRNumber, throwOnFailure, true)
    if (candidate) {
      return normalizeCandidate(candidate)
    }
  }

  if (branchName) {
    const candidate = await fetchCandidateForBranch(repo, branchName, throwOnFailure)
    if (candidate) {
      const state = candidateState(candidate)
      // Why: a merged PR we only matched by branch name is history, not review
      // context (GitHub's isMergedImplicitPR rule). Keeping it reported "a pull
      // request already exists" and blocked the branch's next PR. Scoped to
      // merged so a declined PR stays visible off the default branch, matching
      // every other provider; the linked lookup above already returned early
      // for an explicitly linked review.
      const isMergedImplicitMatch = state === 'merged'
      const hideOnDefaultBranch = await shouldHideNonOpenReviewOnDefaultBranch({
        state,
        reviewNumber: candidate.raw.id ?? null,
        linkedReviewNumber: linkedPRNumber,
        branchName,
        repoPath,
        connectionId,
        localGitOptions: getHostedReviewLocalGitOptions(options)
      })
      if (!isMergedImplicitMatch && !hideOnDefaultBranch) {
        return normalizeCandidate(candidate)
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

export function getBitbucketRepoSlug(
  repoPath: string,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<BitbucketRepoRef | null> {
  return getBitbucketRepoRef(repoPath, connectionId, getHostedReviewLocalGitOptions(options))
}
