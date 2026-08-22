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
  checkPresentationStatus?: CheckPresentationStatus
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
    case undefined:
    default:
      return 'UNKNOWN'
  }
}

function normalizeAzureDevOpsStatus(state: string | null | undefined): CheckOutcomeInput {
  switch (state?.trim().toLowerCase()) {
    case 'succeeded':
    case 'success':
      return { status: 'completed', conclusion: 'success' }
    case 'failed':
    case 'error':
    case 'rejected':
      return { status: 'completed', conclusion: 'failure' }
    case 'canceled':
    case 'cancelled':
      return { status: 'completed', conclusion: 'cancelled' }
    case 'pending':
    case 'inprogress':
    case 'in_progress':
    case 'queued':
    case 'running':
      return { status: 'in_progress', conclusion: 'pending' }
    case undefined:
    default:
      return { status: 'completed', conclusion: 'neutral' }
  }
}

export function deriveAzureDevOpsStatus(statuses: readonly RawAzureDevOpsStatus[]): CheckStatus {
  return deriveAzureDevOpsStatuses(statuses).status
}

export function deriveAzureDevOpsStatuses(
  statuses: readonly RawAzureDevOpsStatus[]
): ProviderCheckStatuses {
  return getProviderCheckStatuses(
    summarizeProviderChecks(statuses.map((status) => normalizeAzureDevOpsStatus(status.state)))
  )
}

export function mapAzureDevOpsPullRequest(
  raw: RawAzureDevOpsPullRequest,
  status: CheckStatus,
  webBaseUrl: string,
  checkPresentationStatus?: CheckPresentationStatus
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
    ...(checkPresentationStatus ? { checkPresentationStatus } : {}),
    updatedAt: raw.closedDate ?? raw.creationDate ?? '',
    mergeable: mapAzureDevOpsMergeable(raw.mergeStatus),
    ...(headSha ? { headSha } : {})
  }
}
