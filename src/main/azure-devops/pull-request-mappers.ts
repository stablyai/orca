import type { CheckStatus, PRMergeableState } from '../../shared/types'

export type RawAzureDevOpsStatus = {
  state?: string | null
}

export type RawAzureDevOpsPullRequest = {
  pullRequestId?: number
  codeReviewId?: number
  title?: string | null
  status?: string | null
  isDraft?: boolean | null
  creationDate?: string | null
  closedDate?: string | null
  mergeStatus?: string | null
  sourceRefName?: string | null
  lastMergeSourceCommit?: {
    commitId?: string | null
  } | null
  statuses?: RawAzureDevOpsStatus[] | null
  _links?: {
    web?: {
      href?: string | null
    } | null
  } | null
}

export type AzureDevOpsPullRequestInfo = {
  number: number
  title: string
  state: 'open' | 'closed' | 'merged' | 'draft'
  url: string
  status: CheckStatus
  updatedAt: string
  mergeable: PRMergeableState
  headSha?: string
}

export function mapAzureDevOpsPullRequestState(
  raw: Pick<RawAzureDevOpsPullRequest, 'isDraft' | 'status'>
): AzureDevOpsPullRequestInfo['state'] {
  const status = raw.status?.trim().toLowerCase()
  if (status === 'completed') {
    return 'merged'
  }
  if (status === 'abandoned') {
    return 'closed'
  }
  if (raw.isDraft) {
    return 'draft'
  }
  return 'open'
}

export function mapAzureDevOpsMergeable(mergeStatus: string | null | undefined): PRMergeableState {
  switch (mergeStatus?.trim().toLowerCase()) {
    case 'succeeded':
      return 'MERGEABLE'
    case 'conflicts':
      return 'CONFLICTING'
    default:
      return 'UNKNOWN'
  }
}

function classifyAzureDevOpsStatus(state: string | null | undefined): CheckStatus {
  switch (state?.trim().toLowerCase()) {
    case 'succeeded':
    case 'success':
      return 'success'
    case 'failed':
    case 'error':
    case 'rejected':
    case 'canceled':
    case 'cancelled':
      return 'failure'
    case 'pending':
    case 'inprogress':
    case 'in_progress':
    case 'queued':
    case 'running':
      return 'pending'
    default:
      return 'neutral'
  }
}

export function deriveAzureDevOpsStatus(statuses: readonly RawAzureDevOpsStatus[]): CheckStatus {
  if (statuses.length === 0) {
    return 'neutral'
  }
  const classified = statuses.map((status) => classifyAzureDevOpsStatus(status.state))
  if (classified.includes('failure')) {
    return 'failure'
  }
  if (classified.includes('pending')) {
    return 'pending'
  }
  if (classified.every((status) => status === 'success')) {
    return 'success'
  }
  return 'neutral'
}

export function mapAzureDevOpsPullRequest(
  raw: RawAzureDevOpsPullRequest,
  status: CheckStatus,
  webBaseUrl: string
): AzureDevOpsPullRequestInfo | null {
  if (typeof raw.pullRequestId !== 'number' || !raw.title) {
    return null
  }
  const headSha = raw.lastMergeSourceCommit?.commitId?.trim()
  return {
    number: raw.pullRequestId,
    title: raw.title,
    state: mapAzureDevOpsPullRequestState(raw),
    url:
      raw._links?.web?.href ?? `${webBaseUrl.replace(/\/+$/, '')}/pullrequest/${raw.pullRequestId}`,
    status,
    updatedAt: raw.closedDate ?? raw.creationDate ?? '',
    mergeable: mapAzureDevOpsMergeable(raw.mergeStatus),
    ...(headSha ? { headSha } : {})
  }
}
