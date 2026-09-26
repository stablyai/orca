import type { CheckStatus } from '../../shared/github/pull-request-types'
import type { BitbucketPullRequestInfo } from './pull-request-mappers'
import type { BitbucketServerRepoRef } from './repository-ref'

/**
 * Data Center's REST payload shares no field names with Bitbucket Cloud's:
 * camelCase instead of snake_case, epoch-millis dates instead of ISO strings,
 * and fully-qualified refs instead of bare branch names.
 */
export type RawBitbucketServerPullRequest = {
  id?: number
  title?: string
  state?: string | null
  updatedDate?: number | null
  fromRef?: {
    id?: string | null
    displayId?: string | null
    latestCommit?: string | null
  } | null
  toRef?: {
    id?: string | null
    displayId?: string | null
  } | null
}

/** `GET /rest/build-status/1.0/commits/stats/{sha}` — pre-aggregated counts. */
export type RawBitbucketServerBuildStats = {
  successful?: number
  inProgress?: number
  failed?: number
  cancelled?: number
  unknown?: number
}

export function mapBitbucketServerPullRequestState(
  state: string | null | undefined
): BitbucketPullRequestInfo['state'] {
  switch (state?.trim().toUpperCase()) {
    case 'MERGED':
      return 'merged'
    case 'DECLINED':
      return 'closed'
    case 'OPEN':
    case undefined:
    default:
      return 'open'
  }
}

export function deriveBitbucketServerBuildStatus(
  stats: RawBitbucketServerBuildStats | null
): CheckStatus {
  const successful = stats?.successful ?? 0
  const inProgress = stats?.inProgress ?? 0
  const failed = stats?.failed ?? 0
  const cancelled = stats?.cancelled ?? 0
  const unknown = stats?.unknown ?? 0
  if (successful + inProgress + failed + cancelled + unknown === 0) {
    return 'neutral'
  }
  if (failed > 0 || cancelled > 0) {
    return 'failure'
  }
  if (inProgress > 0) {
    return 'pending'
  }
  return unknown === 0 ? 'success' : 'neutral'
}

/**
 * Data Center's web UI addresses personal repositories as `/users/{slug}`
 * while REST keeps the `~` prefix on the project key.
 */
export function bitbucketServerRepoWebUrl(repo: BitbucketServerRepoRef): string {
  const owner = repo.projectKey.startsWith('~')
    ? `users/${encodeURIComponent(repo.projectKey.slice(1))}`
    : `projects/${encodeURIComponent(repo.projectKey)}`
  return `${repo.baseUrl}/${owner}/repos/${encodeURIComponent(repo.repoSlug)}`
}

export function mapBitbucketServerPullRequest(
  raw: RawBitbucketServerPullRequest,
  repo: BitbucketServerRepoRef,
  status: CheckStatus
): BitbucketPullRequestInfo | null {
  // Why: `links` is an undocumented, write-only object in the Data Center
  // OpenAPI schema, so the PR URL is constructed rather than read.
  if (typeof raw.id !== 'number' || !raw.title) {
    return null
  }
  const headSha = raw.fromRef?.latestCommit?.trim()
  // Why: Number.isFinite admits epochs beyond ±8.64e15, where toISOString
  // throws RangeError and the error escapes into the review lookup.
  const updatedAt = typeof raw.updatedDate === 'number' ? new Date(raw.updatedDate) : null
  return {
    number: raw.id,
    title: raw.title,
    state: mapBitbucketServerPullRequestState(raw.state),
    url: `${bitbucketServerRepoWebUrl(repo)}/pull-requests/${raw.id}`,
    status,
    updatedAt: updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt.toISOString() : '',
    mergeable: 'UNKNOWN',
    ...(headSha ? { headSha } : {})
  }
}
