import type { CheckStatus, PRMergeableState } from '../../shared/types'

export type RawGiteaPullRequest = {
  number?: number
  title?: string
  state?: string | null
  html_url?: string | null
  updated_at?: string | null
  merged?: boolean | null
  draft?: boolean | null
  mergeable?: boolean | null
  head?: {
    ref?: string | null
    label?: string | null
    sha?: string | null
  } | null
}

export type GiteaPullRequestInfo = {
  number: number
  title: string
  state: 'open' | 'closed' | 'merged' | 'draft'
  url: string
  status: CheckStatus
  updatedAt: string
  mergeable: PRMergeableState
  headSha?: string
}

export type RawGiteaCombinedStatus = {
  state?: string | null
  statuses?: RawGiteaCommitStatus[] | null
}

export type RawGiteaCommitStatus = {
  status?: string | null
  state?: string | null
}

function classifyGiteaStatus(status: string | null | undefined): CheckStatus {
  switch (status?.trim().toLowerCase()) {
    case 'success':
      return 'success'
    case 'failure':
    case 'error':
    case 'warning':
      return 'failure'
    case 'pending':
      return 'pending'
    case 'skipped':
    default:
      return 'neutral'
  }
}

export function deriveGiteaCommitStatus(rollup: RawGiteaCombinedStatus | null): CheckStatus {
  if (!rollup) {
    return 'neutral'
  }
  const combined = classifyGiteaStatus(rollup.state)
  if (combined !== 'neutral') {
    return combined
  }
  const statuses = rollup.statuses ?? []
  if (statuses.length === 0) {
    return 'neutral'
  }

  let hasPending = false
  for (const status of statuses) {
    const classified = classifyGiteaStatus(status.status ?? status.state)
    if (classified === 'failure') {
      return 'failure'
    }
    if (classified === 'pending') {
      hasPending = true
    }
  }
  if (hasPending) {
    return 'pending'
  }
  return statuses.every(
    (status) => classifyGiteaStatus(status.status ?? status.state) === 'success'
  )
    ? 'success'
    : 'neutral'
}

export function mapGiteaPullRequestState(
  raw: Pick<RawGiteaPullRequest, 'draft' | 'merged' | 'state'>
): GiteaPullRequestInfo['state'] {
  if (raw.merged) {
    return 'merged'
  }
  if (raw.draft) {
    return 'draft'
  }
  return raw.state?.trim().toLowerCase() === 'closed' ? 'closed' : 'open'
}

export function mapGiteaMergeable(value: boolean | null | undefined): PRMergeableState {
  if (value === true) {
    return 'MERGEABLE'
  }
  if (value === false) {
    return 'CONFLICTING'
  }
  return 'UNKNOWN'
}

export function mapGiteaPullRequest(
  raw: RawGiteaPullRequest,
  status: CheckStatus
): GiteaPullRequestInfo | null {
  if (typeof raw.number !== 'number' || !raw.title || !raw.html_url) {
    return null
  }
  const headSha = raw.head?.sha?.trim()
  return {
    number: raw.number,
    title: raw.title,
    state: mapGiteaPullRequestState(raw),
    url: raw.html_url,
    status,
    updatedAt: raw.updated_at ?? '',
    mergeable: mapGiteaMergeable(raw.mergeable),
    ...(headSha ? { headSha } : {})
  }
}
