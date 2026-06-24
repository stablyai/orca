/* Gitea/Forgejo issue operations — mirrors gitlab/issues.ts function shapes.
   Transport via ./request.ts (single shared auth source). */
import type { GiteaRepoRef } from './repository-ref'
import { getGiteaRepoRef } from './repository-ref'
import { requestJson, encodedRepoPath } from './request'
import { mapGiteaIssueInfo, type GiteaIssueInfo, type RawGiteaIssue } from './issue-mappers'

export type IssueListResult = {
  items: GiteaIssueInfo[]
  error?: { kind: string; message: string }
}

export type IssueListState = 'open' | 'closed' | 'all'

async function resolveRepo(
  repoPath: string,
  connectionId?: string | null
): Promise<GiteaRepoRef | null> {
  return getGiteaRepoRef(repoPath, connectionId)
}

/**
 * Get a single issue by number (per-repo index).
 */
export async function getIssue(
  repoPath: string,
  issueNumber: number,
  connectionId?: string | null
): Promise<GiteaIssueInfo | null> {
  const repo = await resolveRepo(repoPath, connectionId)
  if (!repo) {
    return null
  }
  try {
    const raw = await requestJson<RawGiteaIssue>(
      repo,
      `/repos/${encodedRepoPath(repo)}/issues/${encodeURIComponent(String(issueNumber))}`
    )
    if (!raw) {
      return null
    }
    return mapGiteaIssueInfo(raw)
  } catch {
    return null
  }
}

/**
 * List issues for a repository.
 *
 * Why: type=issues asks the server to exclude PRs, but Gitea/Forgejo may
 * still return PR entries in some configurations. We also filter
 * raw.pull_request != null defensively in mapGiteaIssueInfo.
 */
export async function listIssues(
  repoPath: string,
  limit = 20,
  state: IssueListState = 'open',
  assignee?: string,
  connectionId?: string | null
): Promise<IssueListResult> {
  const repo = await resolveRepo(repoPath, connectionId)
  if (!repo) {
    return {
      items: [],
      error: { kind: 'not_found', message: 'Could not resolve Gitea repository' }
    }
  }
  try {
    const searchParams: Record<string, string | number> = {
      type: 'issues',
      sort: 'recentupdate',
      // Why: Gitea/Forgejo /issues defaults to state=open when the param is
      // omitted, so 'all' must be sent explicitly or closed issues are dropped.
      state,
      limit,
      page: 1
    }
    if (assignee) {
      searchParams.assigned_to = assignee
    }
    const raw = await requestJson<RawGiteaIssue[]>(repo, `/repos/${encodedRepoPath(repo)}/issues`, {
      searchParams
    })
    if (!raw) {
      return {
        items: [],
        error: { kind: 'unknown', message: 'Failed to fetch issues from Gitea' }
      }
    }
    // Why: filter out PR entries — Gitea returns mixed results even with
    // type=issues (gotcha #1 in blueprint).
    const items = raw
      .map((r) => mapGiteaIssueInfo(r))
      .filter((i): i is GiteaIssueInfo => i !== null)
    return { items }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { items: [], error: { kind: 'unknown', message } }
  }
}

/**
 * Create a new issue in the repository.
 */
export async function createIssue(
  repoPath: string,
  title: string,
  body: string,
  connectionId?: string | null
): Promise<{ ok: true; number: number; url: string } | { ok: false; error: string }> {
  const trimmedTitle = title.trim()
  if (!trimmedTitle) {
    return { ok: false, error: 'Title is required' }
  }
  const repo = await resolveRepo(repoPath, connectionId)
  if (!repo) {
    return { ok: false, error: 'Could not resolve Gitea repository for this repository' }
  }
  try {
    const raw = await requestJson<{ number?: number; html_url?: string }>(
      repo,
      `/repos/${encodedRepoPath(repo)}/issues`,
      { method: 'POST', body: { title: trimmedTitle, body } }
    )
    if (!raw || typeof raw.number !== 'number') {
      return { ok: false, error: 'Unexpected response from Gitea' }
    }
    return { ok: true, number: raw.number, url: String(raw.html_url ?? '') }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  }
}

/**
 * Update an existing issue.
 *
 * Why: labels are a sub-resource on Gitea (PUT/POST/DELETE …/labels),
 * NOT a PATCH field (gotcha #4 in blueprint). State + title + body go
 * through PATCH; label mutations go through the /labels sub-resource.
 */
export async function updateIssue(
  repoPath: string,
  issueNumber: number,
  updates: {
    state?: 'open' | 'closed'
    title?: string
    body?: string
    addLabels?: string[]
    removeLabels?: string[]
    assignees?: string[]
  },
  connectionId?: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const repo = await resolveRepo(repoPath, connectionId)
  if (!repo) {
    return { ok: false, error: 'Could not resolve Gitea repository for this repository' }
  }
  const errors: string[] = []
  const basePath = `/repos/${encodedRepoPath(repo)}/issues/${encodeURIComponent(String(issueNumber))}`

  // PATCH — state, title, body, assignees
  const patchBody: Record<string, unknown> = {}
  if (updates.state) {
    patchBody.state = updates.state
  }
  if (updates.title) {
    patchBody.title = updates.title
  }
  if (updates.body !== undefined) {
    patchBody.body = updates.body
  }
  if (updates.assignees !== undefined) {
    patchBody.assignees = updates.assignees
  }
  if (Object.keys(patchBody).length > 0) {
    try {
      await requestJson(repo, basePath, { method: 'PATCH', body: patchBody })
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }

  // Labels sub-resource — gotcha #4: NOT a PATCH field.
  // For addLabels we POST individual label names (Gitea expects label IDs
  // for the body, but the simplest approach is to PUT the full desired set
  // after reading current labels — here we just call PUT to replace all
  // labels with addLabels if provided, or issue a DELETE for removeLabels).
  // Simplified: addLabels → POST /labels (by name); removeLabels → individual DELETE.
  // NOTE: Gitea label operations use label IDs, not names. We fetch IDs first.
  if ((updates.addLabels?.length ?? 0) > 0 || (updates.removeLabels?.length ?? 0) > 0) {
    try {
      // Fetch repo labels to resolve name → ID
      const repoLabels = await requestJson<{ id?: number; name?: string }[]>(
        repo,
        `/repos/${encodedRepoPath(repo)}/labels`
      )
      const labelMap = new Map<string, number>()
      for (const lbl of repoLabels ?? []) {
        if (lbl.name && typeof lbl.id === 'number') {
          labelMap.set(lbl.name, lbl.id)
        }
      }

      if (updates.addLabels && updates.addLabels.length > 0) {
        const ids = updates.addLabels
          .map((name) => labelMap.get(name))
          .filter((id): id is number => id !== undefined)
        if (ids.length > 0) {
          await requestJson(repo, `${basePath}/labels`, { method: 'POST', body: { labels: ids } })
        }
      }

      if (updates.removeLabels && updates.removeLabels.length > 0) {
        for (const name of updates.removeLabels) {
          const id = labelMap.get(name)
          if (typeof id === 'number') {
            await requestJson(repo, `${basePath}/labels/${encodeURIComponent(String(id))}`, {
              method: 'DELETE'
            })
          }
        }
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }

  if (errors.length > 0) {
    return { ok: false, error: errors.join('; ') }
  }
  return { ok: true }
}

/**
 * Add a comment to an existing issue.
 */
export async function addIssueComment(
  repoPath: string,
  issueNumber: number,
  body: string,
  connectionId?: string | null
): Promise<
  | { ok: true; comment: { id: number; body: string; createdAt: string } }
  | { ok: false; error: string }
> {
  const repo = await resolveRepo(repoPath, connectionId)
  if (!repo) {
    return { ok: false, error: 'Could not resolve Gitea repository for this repository' }
  }
  try {
    const raw = await requestJson<{
      id?: number
      body?: string
      created_at?: string
      user?: { login?: string; avatar_url?: string } | null
    }>(
      repo,
      `/repos/${encodedRepoPath(repo)}/issues/${encodeURIComponent(String(issueNumber))}/comments`,
      { method: 'POST', body: { body } }
    )
    if (!raw) {
      return { ok: false, error: 'Unexpected response from Gitea' }
    }
    return {
      ok: true,
      comment: {
        id: raw.id ?? Date.now(),
        body: raw.body ?? body,
        createdAt: raw.created_at ?? new Date().toISOString()
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  }
}

/**
 * List available labels for the repository.
 */
export async function listLabels(
  repoPath: string,
  connectionId?: string | null
): Promise<string[]> {
  const repo = await resolveRepo(repoPath, connectionId)
  if (!repo) {
    return []
  }
  try {
    const raw = await requestJson<{ name?: string | null }[]>(
      repo,
      `/repos/${encodedRepoPath(repo)}/labels`
    )
    return (raw ?? []).map((l) => l.name ?? '').filter((n) => n.length > 0)
  } catch {
    return []
  }
}

/**
 * List users who can be assigned to issues in this repository.
 */
export async function listAssignableUsers(
  repoPath: string,
  connectionId?: string | null
): Promise<{ username: string; name: string | null; avatarUrl: string }[]> {
  const repo = await resolveRepo(repoPath, connectionId)
  if (!repo) {
    return []
  }
  try {
    const raw = await requestJson<
      {
        login?: string | null
        full_name?: string | null
        avatar_url?: string | null
      }[]
    >(repo, `/repos/${encodedRepoPath(repo)}/assignees`)
    return (raw ?? [])
      .filter((u) => u.login)
      .map((u) => ({
        username: u.login!,
        name: u.full_name ?? null,
        avatarUrl: u.avatar_url ?? ''
      }))
  } catch {
    return []
  }
}
