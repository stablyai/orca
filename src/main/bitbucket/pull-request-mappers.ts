import type { CheckStatus, PRMergeableState } from '../../shared/types'

export type RawBitbucketPullRequest = {
  id?: number
  title?: string
  state?: string | null
  updated_on?: string | null
  links?: {
    html?: {
      href?: string
    }
  }
  source?: {
    branch?: {
      name?: string
    }
    commit?: {
      hash?: string
    } | null
  }
  destination?: {
    branch?: {
      name?: string
    }
  }
}

export type BitbucketPullRequestInfo = {
  number: number
  title: string
  state: 'open' | 'closed' | 'merged'
  url: string
  status: CheckStatus
  updatedAt: string
  mergeable: PRMergeableState
  headSha?: string
}

export type RawBitbucketBuildStatus = {
  state?: string | null
}

export function mapBitbucketPullRequestState(
  state: string | null | undefined
): BitbucketPullRequestInfo['state'] {
  switch (state?.trim().toUpperCase()) {
    case 'MERGED':
      return 'merged'
    case 'DECLINED':
    case 'SUPERSEDED':
      return 'closed'
    case 'OPEN':
    default:
      return 'open'
  }
}

export function deriveBitbucketBuildStatus(
  statuses: readonly RawBitbucketBuildStatus[]
): CheckStatus {
  if (statuses.length === 0) {
    return 'neutral'
  }
  const states = statuses.map((status) => status.state?.trim().toUpperCase() ?? '')
  if (states.some((state) => state === 'FAILED' || state === 'STOPPED' || state === 'ERROR')) {
    return 'failure'
  }
  if (states.some((state) => state === 'INPROGRESS' || state === 'PENDING')) {
    return 'pending'
  }
  if (states.every((state) => state === 'SUCCESSFUL')) {
    return 'success'
  }
  return 'neutral'
}

export function mapBitbucketPullRequest(
  raw: RawBitbucketPullRequest,
  status: CheckStatus
): BitbucketPullRequestInfo | null {
  if (typeof raw.id !== 'number' || !raw.title || !raw.links?.html?.href) {
    return null
  }
  const headSha = raw.source?.commit?.hash?.trim()
  return {
    number: raw.id,
    title: raw.title,
    state: mapBitbucketPullRequestState(raw.state),
    url: raw.links.html.href,
    status,
    updatedAt: raw.updated_on ?? '',
    mergeable: 'UNKNOWN',
    ...(headSha ? { headSha } : {})
  }
}
