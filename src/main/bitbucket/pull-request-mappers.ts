import type {
  CheckPresentationStatus,
  CheckStatus,
  PRMergeableState
} from '../../shared/github/pull-request-types'
import {
  getProviderCheckStatuses,
  summarizeProviderChecks,
  type CheckOutcomeInput,
  type ProviderCheckStatuses
} from '../../shared/provider-check-summary'

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
  checkPresentationStatus?: CheckPresentationStatus
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
    case undefined:
    default:
      return 'open'
  }
}

export function deriveBitbucketBuildStatus(
  statuses: readonly RawBitbucketBuildStatus[]
): CheckStatus {
  return deriveBitbucketBuildStatuses(statuses).status
}

function normalizeBitbucketBuildStatus(state: string | null | undefined): CheckOutcomeInput {
  switch (state?.trim().toUpperCase()) {
    case 'SUCCESSFUL':
      return { status: 'completed', conclusion: 'success' }
    case 'FAILED':
    case 'ERROR':
      return { status: 'completed', conclusion: 'failure' }
    case 'STOPPED':
      return { status: 'completed', conclusion: 'cancelled' }
    case 'INPROGRESS':
    case 'PENDING':
      return { status: 'in_progress', conclusion: 'pending' }
    case undefined:
    default:
      return { status: 'completed', conclusion: 'neutral' }
  }
}

export function deriveBitbucketBuildStatuses(
  statuses: readonly RawBitbucketBuildStatus[]
): ProviderCheckStatuses {
  return getProviderCheckStatuses(
    summarizeProviderChecks(statuses.map((status) => normalizeBitbucketBuildStatus(status.state)))
  )
}

export function mapBitbucketPullRequest(
  raw: RawBitbucketPullRequest,
  status: CheckStatus,
  checkPresentationStatus?: CheckPresentationStatus
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
    ...(checkPresentationStatus ? { checkPresentationStatus } : {}),
    updatedAt: raw.updated_on ?? '',
    mergeable: 'UNKNOWN',
    ...(headSha ? { headSha } : {})
  }
}
