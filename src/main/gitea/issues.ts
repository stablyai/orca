import type {
  GiteaComment,
  GiteaCreateIssueResult,
  GiteaIssue,
  GiteaIssueUpdate,
  GiteaLabel,
  GiteaMutationResult,
  GiteaUser,
  GiteaWorkItem,
  GiteaWorkItemFilter
} from '../../shared/gitea-types'
import { getGiteaRepoRef, type GiteaRepoRef } from './repository-ref'
import { encodedRepoPath, giteaRepoGet, giteaRepoWrite } from './request'
import { getServerForHost } from './server-store'
import {
  isGiteaPullRequest,
  mapGiteaComment,
  mapGiteaIssue,
  mapGiteaLabel,
  mapGiteaUser,
  mapGiteaWorkItem,
  type GiteaIssueContext,
  type RawGiteaComment,
  type RawGiteaIssue,
  type RawGiteaLabel,
  type RawGiteaUser
} from './mappers'

const DEFAULT_LIMIT = 30
const MAX_LIMIT = 100

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    return DEFAULT_LIMIT
  }
  return Math.min(Math.max(1, Math.floor(limit)), MAX_LIMIT)
}

const MAX_SEARCH_PAGES = 10

// The global /repos/issues/search endpoint returns hits across every repo under
// the owner. Filtering a single capped page down to the selected repo can drop
// valid matches when other repos dominate earlier pages, so page through results
// (filtering server-side hits by full_name) until we collect `max` matches or
// exhaust the available pages.
async function collectAssignedOrCreated(
  repo: GiteaRepoRef,
  filter: 'assigned' | 'created',
  max: number
): Promise<RawGiteaIssue[]> {
  const fullName = `${repo.owner}/${repo.repo}`.toLowerCase()
  const matches: RawGiteaIssue[] = []
  for (let page = 1; page <= MAX_SEARCH_PAGES && matches.length < max; page += 1) {
    const raw = await giteaRepoGet<RawGiteaIssue[]>(repo, `/repos/issues/search`, {
      searchParams: {
        [filter]: 'true',
        state: 'open',
        owner: repo.owner,
        limit: max,
        page
      }
    })
    if (!Array.isArray(raw) || raw.length === 0) {
      break
    }
    for (const entry of raw) {
      if ((entry.repository?.full_name ?? '').toLowerCase() === fullName) {
        matches.push(entry)
        if (matches.length >= max) {
          break
        }
      }
    }
    // A short page means there are no further results to page through.
    if (raw.length < max) {
      break
    }
  }
  return matches.slice(0, max)
}

function issueContext(repo: GiteaRepoRef): GiteaIssueContext {
  const stored = getServerForHost(repo.host)
  return {
    owner: repo.owner,
    repo: repo.repo,
    serverId: stored?.server.id,
    serverName: stored?.server.displayName
  }
}

// Lists issues and pull requests together as unified work items, matching the
// GitHub/GitLab Tasks model.
//
// "Assigned to me" / "Created by me" use the global /repos/issues/search
// endpoint, whose `assigned`/`created` booleans filter by the token's user
// server-side (the repo-level /issues endpoint only filters by an explicit
// username, which needs the read:user scope). Search hits are scoped back to
// the selected repo by owner + full_name. "Open"/"Closed" use the repo-level
// endpoint, which is naturally scoped and cheaper.
export async function listGiteaWorkItems(
  repoPath: string,
  filter?: GiteaWorkItemFilter,
  limit?: number,
  connectionId?: string | null
): Promise<GiteaWorkItem[]> {
  const repo = await getGiteaRepoRef(repoPath, connectionId)
  if (!repo) {
    return []
  }
  const context = issueContext(repo)
  const max = clampLimit(limit)

  if (filter === 'assigned' || filter === 'created') {
    const matches = await collectAssignedOrCreated(repo, filter, max)
    return matches
      .map((entry) => mapGiteaWorkItem(entry, context))
      .filter((item): item is GiteaWorkItem => item !== null)
  }

  const raw = await giteaRepoGet<RawGiteaIssue[]>(repo, `/repos/${encodedRepoPath(repo)}/issues`, {
    searchParams: { state: filter === 'closed' ? 'closed' : 'open', limit: max, page: 1 }
  })
  if (!Array.isArray(raw)) {
    return []
  }
  return raw
    .map((entry) => mapGiteaWorkItem(entry, context))
    .filter((item): item is GiteaWorkItem => item !== null)
}

export async function listGiteaLabels(
  repoPath: string,
  connectionId?: string | null
): Promise<GiteaLabel[]> {
  const repo = await getGiteaRepoRef(repoPath, connectionId)
  if (!repo) {
    return []
  }
  const raw = await giteaRepoGet<RawGiteaLabel[]>(repo, `/repos/${encodedRepoPath(repo)}/labels`, {
    searchParams: { limit: 100, page: 1 }
  })
  if (!Array.isArray(raw)) {
    return []
  }
  return raw
    .map((entry) => mapGiteaLabel(entry))
    .filter((label): label is GiteaLabel => label !== null)
}

export async function listGiteaAssignees(
  repoPath: string,
  connectionId?: string | null
): Promise<GiteaUser[]> {
  const repo = await getGiteaRepoRef(repoPath, connectionId)
  if (!repo) {
    return []
  }
  const raw = await giteaRepoGet<RawGiteaUser[]>(repo, `/repos/${encodedRepoPath(repo)}/assignees`)
  if (!Array.isArray(raw)) {
    return []
  }
  return raw
    .map((entry) => mapGiteaUser(entry))
    .filter((user): user is GiteaUser => user !== undefined)
}

export async function getGiteaIssue(
  repoPath: string,
  issueNumber: number,
  connectionId?: string | null
): Promise<GiteaIssue | null> {
  const repo = await getGiteaRepoRef(repoPath, connectionId)
  if (!repo) {
    return null
  }
  const raw = await giteaRepoGet<RawGiteaIssue>(
    repo,
    `/repos/${encodedRepoPath(repo)}/issues/${encodeURIComponent(String(issueNumber))}`
  )
  if (!raw || isGiteaPullRequest(raw)) {
    return null
  }
  return mapGiteaIssue(raw, issueContext(repo))
}

export async function listGiteaIssueComments(
  repoPath: string,
  issueNumber: number,
  connectionId?: string | null
): Promise<GiteaComment[]> {
  const repo = await getGiteaRepoRef(repoPath, connectionId)
  if (!repo) {
    return []
  }
  const raw = await giteaRepoGet<RawGiteaComment[]>(
    repo,
    `/repos/${encodedRepoPath(repo)}/issues/${encodeURIComponent(String(issueNumber))}/comments`
  )
  if (!Array.isArray(raw)) {
    return []
  }
  return raw
    .map((entry) => mapGiteaComment(entry))
    .filter((comment): comment is GiteaComment => comment !== null)
}

export async function createGiteaIssue(
  repoPath: string,
  input: { title: string; body?: string; assignees?: string[]; labelIds?: number[] },
  connectionId?: string | null
): Promise<GiteaCreateIssueResult> {
  const repo = await getGiteaRepoRef(repoPath, connectionId)
  if (!repo) {
    return { ok: false, error: 'This repository is not a recognized Gitea remote.' }
  }
  const result = await giteaRepoWrite<RawGiteaIssue>(
    repo,
    `/repos/${encodedRepoPath(repo)}/issues`,
    {
      method: 'POST',
      body: {
        title: input.title,
        body: input.body ?? '',
        ...(input.assignees ? { assignees: input.assignees } : {}),
        ...(input.labelIds ? { labels: input.labelIds } : {})
      }
    }
  )
  if (!result.ok) {
    return { ok: false, error: result.error }
  }
  const raw = result.data
  if (typeof raw.id !== 'number' || typeof raw.number !== 'number') {
    return { ok: false, error: 'Gitea did not return the created issue.' }
  }
  return { ok: true, id: raw.id, number: raw.number, url: raw.html_url ?? '' }
}

export async function updateGiteaIssue(
  repoPath: string,
  issueNumber: number,
  updates: GiteaIssueUpdate,
  connectionId?: string | null
): Promise<GiteaMutationResult> {
  const repo = await getGiteaRepoRef(repoPath, connectionId)
  if (!repo) {
    return { ok: false, error: 'This repository is not a recognized Gitea remote.' }
  }
  const body: Record<string, unknown> = {}
  if (updates.title !== undefined) {
    body.title = updates.title
  }
  if (updates.body !== undefined) {
    body.body = updates.body
  }
  if (updates.state !== undefined) {
    body.state = updates.state
  }
  if (updates.assignees !== undefined) {
    body.assignees = updates.assignees
  }
  const path = `/repos/${encodedRepoPath(repo)}/issues/${encodeURIComponent(String(issueNumber))}`
  // Why: skip the issue PATCH when only labels changed — labels use a dedicated
  // endpoint, so an empty PATCH is a wasted call and avoidable failure point.
  if (Object.keys(body).length > 0) {
    const result = await giteaRepoWrite<RawGiteaIssue>(repo, path, { method: 'PATCH', body })
    if (!result.ok) {
      return { ok: false, error: result.error }
    }
  }
  // Label edits use a dedicated endpoint in the Gitea API.
  if (updates.labelIds !== undefined) {
    const labelResult = await giteaRepoWrite<unknown>(repo, `${path}/labels`, {
      method: 'PUT',
      body: { labels: updates.labelIds }
    })
    if (!labelResult.ok) {
      return { ok: false, error: labelResult.error }
    }
  }
  return { ok: true }
}

export async function addGiteaIssueComment(
  repoPath: string,
  issueNumber: number,
  body: string,
  connectionId?: string | null
): Promise<GiteaMutationResult> {
  const repo = await getGiteaRepoRef(repoPath, connectionId)
  if (!repo) {
    return { ok: false, error: 'This repository is not a recognized Gitea remote.' }
  }
  const result = await giteaRepoWrite<RawGiteaComment>(
    repo,
    `/repos/${encodedRepoPath(repo)}/issues/${encodeURIComponent(String(issueNumber))}/comments`,
    { method: 'POST', body: { body } }
  )
  return result.ok ? { ok: true } : { ok: false, error: result.error }
}
