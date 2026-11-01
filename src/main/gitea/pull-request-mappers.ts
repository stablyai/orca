import type { CheckStatus, PRMergeableState } from '../../shared/github/pull-request-types'

export type RawGiteaPullRequest = {
  number?: number
  title?: string
  state?: string | null
  html_url?: string | null
  updated_at?: string | null
  merged?: boolean | null
  has_merged?: boolean | null
  draft?: boolean | null
  mergeable?: boolean | null
  user?: { login?: string | null; username?: string | null } | null
  labels?: ({ name?: string | null } | string)[] | null
  head?: {
    ref?: string | null
    label?: string | null
    sha?: string | null
    repo?: { full_name?: string | null } | null
  } | null
  body?: string | null
  requested_reviewers?: unknown
  base?: {
    ref?: string | null
    sha?: string | null
    repo?: { full_name?: string | null } | null
  } | null
}

export type GiteaWorkItem = {
  id: string
  type: 'issue' | 'pr'
  number: number
  title: string
  state: GiteaPullRequestInfo['state']
  url: string
  labels: string[]
  updatedAt: string
  author: string | null
  branchName?: string
  baseRefName?: string
  headSha?: string
  isCrossRepository?: boolean
  repoId: string
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
    case undefined:
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
  raw: Pick<RawGiteaPullRequest, 'draft' | 'merged' | 'has_merged' | 'state'>
): GiteaPullRequestInfo['state'] {
  if (raw.merged || raw.has_merged) {
    return 'merged'
  }
  // Closed PRs can retain their draft flag; terminal state takes precedence.
  if (raw.state?.trim().toLowerCase() === 'closed') {
    return 'closed'
  }
  if (raw.draft) {
    return 'draft'
  }
  return 'open'
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

function labelName(label: { name?: string | null } | string): string | null {
  if (typeof label === 'string') {
    const trimmed = label.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  const name = label.name?.trim()
  return name ? name : null
}

export function mapGiteaPRToWorkItem(
  raw: RawGiteaPullRequest,
  repoId: string
): GiteaWorkItem | null {
  if (typeof raw.number !== 'number' || !raw.title || !raw.html_url) {
    return null
  }
  const labels = (raw.labels ?? [])
    .map((label) => labelName(label))
    .filter((label): label is string => label !== null)
  const branchName = raw.head?.ref?.trim()
  const baseRefName = raw.base?.ref?.trim()
  const headSha = raw.head?.sha?.trim()
  const headRepo = raw.head?.repo?.full_name?.trim()
  const baseRepo = raw.base?.repo?.full_name?.trim()
  return {
    id: `gitea-pr-${repoId}-${raw.number}`,
    type: 'pr',
    number: raw.number,
    title: raw.title,
    state: mapGiteaPullRequestState(raw),
    url: raw.html_url,
    labels,
    updatedAt: raw.updated_at ?? '',
    author: raw.user?.login ?? raw.user?.username ?? null,
    repoId,
    ...(branchName ? { branchName } : {}),
    ...(baseRefName ? { baseRefName } : {}),
    ...(headSha ? { headSha } : {}),
    ...(headRepo && baseRepo ? { isCrossRepository: headRepo !== baseRepo } : {})
  }
}
