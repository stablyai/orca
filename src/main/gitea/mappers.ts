import type { GiteaWorkItem } from './pull-request-mappers'

export type RawGiteaIssue = {
  number?: number
  title?: string
  body?: string | null
  state?: string | null
  html_url?: string | null
  updated_at?: string | null
  pull_request?: unknown
  user?: { login?: string | null; username?: string | null } | null
  labels?: ({ name?: string | null } | string)[] | null
  assignees?: ({ login?: string | null; username?: string | null } | null)[] | null
}

export type GiteaIssueInfo = {
  number: number
  title: string
  body: string
  state: 'open' | 'closed'
  url: string
  author: string | null
  labels: string[]
  assignees: string[]
  updatedAt: string
}

function accountName(
  user: { login?: string | null; username?: string | null } | null | undefined
): string | null {
  const name = user?.login?.trim() || user?.username?.trim()
  return name ? name : null
}

function labelName(label: { name?: string | null } | string): string | null {
  if (typeof label === 'string') {
    const trimmed = label.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  const name = label.name?.trim()
  return name ? name : null
}

export function mapGiteaIssueInfo(raw: RawGiteaIssue): GiteaIssueInfo | null {
  if (typeof raw.number !== 'number' || !raw.title || !raw.html_url) {
    return null
  }
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? '',
    state: raw.state?.trim().toLowerCase() === 'open' ? 'open' : 'closed',
    url: raw.html_url,
    author: accountName(raw.user),
    labels: (raw.labels ?? [])
      .map((label) => labelName(label))
      .filter((label): label is string => label !== null),
    assignees: (raw.assignees ?? [])
      .map((assignee) => accountName(assignee))
      .filter((assignee): assignee is string => assignee !== null),
    updatedAt: raw.updated_at ?? ''
  }
}

export function mapGiteaIssueInfoToWorkItem(issue: GiteaIssueInfo, repoId: string): GiteaWorkItem {
  return {
    id: `gitea-issue-${repoId}-${issue.number}`,
    type: 'issue',
    number: issue.number,
    title: issue.title,
    state: issue.state,
    url: issue.url,
    labels: issue.labels,
    updatedAt: issue.updatedAt,
    author: issue.author,
    repoId
  }
}

export function mapGiteaIssueToWorkItem(raw: RawGiteaIssue, repoId: string): GiteaWorkItem | null {
  const issue = mapGiteaIssueInfo(raw)
  return issue ? mapGiteaIssueInfoToWorkItem(issue, repoId) : null
}
