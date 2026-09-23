import type {
  GiteaComment,
  GiteaIssue,
  GiteaLabel,
  GiteaUser,
  GiteaWorkItem
} from '../../shared/gitea-types'

export type RawGiteaUser = {
  id?: number
  login?: string | null
  full_name?: string | null
  avatar_url?: string | null
}

export type RawGiteaLabel = {
  id?: number
  name?: string | null
  color?: string | null
}

export type RawGiteaIssue = {
  id?: number
  number?: number
  title?: string | null
  body?: string | null
  state?: string | null
  html_url?: string | null
  user?: RawGiteaUser | null
  labels?: RawGiteaLabel[] | null
  assignees?: RawGiteaUser[] | null
  milestone?: { title?: string | null } | null
  comments?: number
  created_at?: string | null
  updated_at?: string | null
  // Present (non-null) when the /issues endpoint returns a pull request.
  pull_request?: { merged?: boolean | null; draft?: boolean | null } | null
  // Present on /repos/issues/search results; used to scope cross-repo search
  // hits back to the selected repository.
  repository?: { full_name?: string | null } | null
}

export type RawGiteaComment = {
  id?: number
  body?: string | null
  created_at?: string | null
  updated_at?: string | null
  user?: RawGiteaUser | null
}

export type GiteaIssueContext = {
  owner: string
  repo: string
  serverId?: string
  serverName?: string
}

// Why: Gitea's /issues endpoint returns pull requests too; they carry a
// non-null pull_request field that issue listings must drop.
export function isGiteaPullRequest(raw: RawGiteaIssue): boolean {
  return raw.pull_request != null
}

export function mapGiteaUser(raw: RawGiteaUser | null | undefined): GiteaUser | undefined {
  const login = raw?.login?.trim()
  if (!raw || typeof raw.id !== 'number' || !login) {
    return undefined
  }
  return {
    id: raw.id,
    login,
    fullName: raw.full_name?.trim() || undefined,
    avatarUrl: raw.avatar_url?.trim() || undefined
  }
}

function mapLabelNames(labels: RawGiteaLabel[] | null | undefined): string[] {
  if (!Array.isArray(labels)) {
    return []
  }
  return labels.map((label) => label.name?.trim()).filter((name): name is string => Boolean(name))
}

function mapAssignees(assignees: RawGiteaUser[] | null | undefined): GiteaUser[] {
  if (!Array.isArray(assignees)) {
    return []
  }
  return assignees
    .map((assignee) => mapGiteaUser(assignee))
    .filter((user): user is GiteaUser => user !== undefined)
}

export function mapGiteaIssue(raw: RawGiteaIssue, context: GiteaIssueContext): GiteaIssue | null {
  if (typeof raw.id !== 'number' || typeof raw.number !== 'number') {
    return null
  }
  return {
    id: raw.id,
    number: raw.number,
    serverId: context.serverId,
    serverName: context.serverName,
    repoOwner: context.owner,
    repoName: context.repo,
    title: raw.title?.trim() ?? '',
    body: raw.body?.trim() || undefined,
    state: raw.state === 'closed' ? 'closed' : 'open',
    url: raw.html_url ?? '',
    labels: mapLabelNames(raw.labels),
    assignees: mapAssignees(raw.assignees),
    author: mapGiteaUser(raw.user),
    milestone: raw.milestone?.title?.trim() || undefined,
    comments: typeof raw.comments === 'number' ? raw.comments : 0,
    updatedAt: raw.updated_at ?? '',
    createdAt: raw.created_at ?? ''
  }
}

// Maps a raw /issues entry (which may be an issue or a pull request) to a
// unified work item, tagging the type and merged/draft state from pull_request.
export function mapGiteaWorkItem(
  raw: RawGiteaIssue,
  context: GiteaIssueContext
): GiteaWorkItem | null {
  if (typeof raw.id !== 'number' || typeof raw.number !== 'number') {
    return null
  }
  const isPull = isGiteaPullRequest(raw)
  const closed = raw.state === 'closed'
  const state: GiteaWorkItem['state'] =
    isPull && closed && raw.pull_request?.merged ? 'merged' : closed ? 'closed' : 'open'
  return {
    id: raw.id,
    type: isPull ? 'pull' : 'issue',
    number: raw.number,
    serverId: context.serverId,
    serverName: context.serverName,
    repoOwner: context.owner,
    repoName: context.repo,
    title: raw.title?.trim() ?? '',
    state,
    url: raw.html_url ?? '',
    labels: mapLabelNames(raw.labels),
    author: mapGiteaUser(raw.user),
    comments: typeof raw.comments === 'number' ? raw.comments : 0,
    ...(isPull && raw.pull_request?.draft ? { draft: true } : {}),
    updatedAt: raw.updated_at ?? '',
    createdAt: raw.created_at ?? ''
  }
}

export function mapGiteaLabel(raw: RawGiteaLabel): GiteaLabel | null {
  if (typeof raw.id !== 'number' || !raw.name?.trim()) {
    return null
  }
  return {
    id: raw.id,
    name: raw.name.trim(),
    color: raw.color?.trim() || undefined
  }
}

export function mapGiteaComment(raw: RawGiteaComment): GiteaComment | null {
  if (typeof raw.id !== 'number') {
    return null
  }
  return {
    id: raw.id,
    body: raw.body ?? '',
    createdAt: raw.created_at ?? '',
    updatedAt: raw.updated_at ?? undefined,
    user: mapGiteaUser(raw.user)
  }
}
