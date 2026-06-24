/* Gitea/Forgejo issue mappers — mirrors gitlab/mappers.ts and
   gitea/pull-request-mappers.ts shape. */

export type RawGiteaIssue = {
  number?: number
  title?: string | null
  state?: string | null
  html_url?: string | null
  body?: string | null
  updated_at?: string | null
  labels?: { name?: string | null }[] | null
  user?: { login?: string | null; avatar_url?: string | null } | null
  /** Why: Gitea /issues returns both issues and PRs in mixed endpoints.
   *  A pull_request field (even if empty object) signals this record is a
   *  PR; we must skip it so the issue list doesn't show PRs. */
  pull_request?: unknown | null
  assignees?: { login?: string | null; avatar_url?: string | null }[] | null
}

export type GiteaIssueInfo = {
  number: number
  title: string
  state: 'open' | 'closed'
  url: string
  labels: string[]
  updatedAt?: string
  description?: string
  author?: string
  authorAvatarUrl?: string
}

export function mapGiteaIssueState(state: string | null | undefined): GiteaIssueInfo['state'] {
  return state?.trim().toLowerCase() === 'closed' ? 'closed' : 'open'
}

export function mapGiteaIssueInfo(raw: RawGiteaIssue): GiteaIssueInfo | null {
  // Why: skip PR entries — Gitea /issues can return PRs even with type=issues
  // filter. Defensive guard mirrors github/issues.ts pull_request filter.
  if (raw.pull_request != null) {
    return null
  }
  if (typeof raw.number !== 'number' || !raw.title || !raw.html_url) {
    return null
  }
  const labels = (raw.labels ?? []).map((l) => l.name ?? '').filter((n) => n.length > 0)
  return {
    number: raw.number,
    title: raw.title,
    state: mapGiteaIssueState(raw.state),
    url: raw.html_url,
    labels,
    ...(raw.updated_at ? { updatedAt: raw.updated_at } : {}),
    ...(typeof raw.body === 'string' ? { description: raw.body } : {}),
    ...(raw.user?.login ? { author: raw.user.login } : {}),
    ...(raw.user?.avatar_url ? { authorAvatarUrl: raw.user.avatar_url } : {})
  }
}
