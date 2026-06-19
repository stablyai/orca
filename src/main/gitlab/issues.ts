/* eslint-disable max-lines -- Why: parallel to src/main/github/issues.ts —
co-locating issue list/create/update/comment operations keeps the shared
acquire/release + error-classification pattern obvious. Each function is
short; the file is long because the surface is broad. */
import type {
  ClassifiedError,
  GitLabAssignableUser,
  GitLabCommentResult,
  GitLabIssueInfo,
  GitLabIssueUpdate,
  IssueSourcePreference,
  MRComment
} from '../../shared/types'
import { mapGitLabIssueInfo } from './mappers'
// prettier-ignore
import { glabExecFileAsync, acquire, release, getIssueProjectRef, resolveIssueSource, classifyGlabError, classifyListIssuesError, getGlabKnownHosts, glabRepoExecOptions, glabHostnameArgs, type LocalGitExecOptions, type ProjectRef } from './gl-utils'

// Why: parallel to GitHub's IssueListResult — distinguishes a successful-
// empty listing from a failed fetch.
export type IssueListResult = {
  items: GitLabIssueInfo[]
  error?: ClassifiedError
}

// Why: GitLab REST API addresses projects by URL-encoded path. Centralize
// the encoding so a future call site can't forget it (the slash escapes
// are easy to miss).
function encodedProject(projectPath: string): string {
  return encodeURIComponent(projectPath)
}

/**
 * Get a single issue by number.
 *
 * Why this path doesn't take a preference — mirrors the GitHub issues.ts
 * commentary: linked-issue lookups persist a number to a worktree at
 * creation time. Routing detail lookups through the live per-repo
 * preference would silently flip an existing link to a different project
 * after the user toggled the selector.
 */
export async function getIssue(
  repoPath: string,
  issueNumber: number,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitLabIssueInfo | null> {
  const knownHosts = await getGlabKnownHosts()
  const projectRef = await getIssueProjectRef(repoPath, knownHosts, connectionId, localGitOptions)
  await acquire()
  try {
    if (projectRef) {
      const { stdout } = await glabExecFileAsync(
        [
          'api',
          ...glabHostnameArgs(projectRef, connectionId),
          `projects/${encodedProject(projectRef.path)}/issues/${issueNumber}`
        ],
        glabRepoExecOptions(repoPath, connectionId, localGitOptions)
      )
      const data = JSON.parse(stdout)
      return mapGitLabIssueInfo(data)
    }
    // Fallback for non-GitLab remotes — let glab infer the project from cwd.
    const { stdout } = await glabExecFileAsync(
      ['issue', 'view', String(issueNumber), '--output', 'json'],
      glabRepoExecOptions(repoPath, connectionId, localGitOptions)
    )
    const data = JSON.parse(stdout)
    return mapGitLabIssueInfo(data)
  } catch {
    return null
  } finally {
    release()
  }
}

/**
 * List issues for a project.
 *
 * Mirrors github/listIssues — returns a structured IssueListResult so
 * permission errors surface in the UI instead of collapsing to "No issues".
 */
// Why: GitLab issues only have 'opened' / 'closed' lifecycle states.
// 'all' maps to no state param so the API returns both.
export type IssueListState = 'opened' | 'closed' | 'all'

export async function listIssues(
  repoPath: string,
  limit = 20,
  preference?: IssueSourcePreference,
  state: IssueListState = 'opened',
  assignee?: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<IssueListResult> {
  const knownHosts = await getGlabKnownHosts()
  const { source: projectRef } = await resolveIssueSource(
    repoPath,
    preference,
    knownHosts,
    connectionId,
    localGitOptions
  )
  await acquire()
  try {
    if (projectRef) {
      const stateParam = state === 'all' ? '' : `&state=${state}`
      const scopeParam = assignee === '@me' ? '&scope=assigned_to_me' : ''
      const { stdout } = await glabExecFileAsync(
        [
          'api',
          ...glabHostnameArgs(projectRef, connectionId),
          `projects/${encodedProject(projectRef.path)}/issues?per_page=${limit}&order_by=updated_at&sort=desc${stateParam}${scopeParam}`
        ],
        glabRepoExecOptions(repoPath, connectionId, localGitOptions)
      )
      const data = JSON.parse(stdout) as Record<string, unknown>[]
      // Why: GitLab's project issues endpoint returns true issues only
      // (MRs are a separate endpoint), so no equivalent of GitHub's
      // pull_request filter is needed here.
      return {
        items: data.map((d) => mapGitLabIssueInfo(d as Parameters<typeof mapGitLabIssueInfo>[0]))
      }
    }
    // Fallback — let glab infer project from cwd. glab issue list defaults
    // to opened; only pass --closed / --all when explicitly requested.
    const stateFlag = state === 'closed' ? ['--closed'] : state === 'all' ? ['--all'] : []
    const assigneeFlag = assignee ? ['--assignee', assignee] : []
    const { stdout } = await glabExecFileAsync(
      [
        'issue',
        'list',
        '--output',
        'json',
        '--per-page',
        String(limit),
        '--order',
        'updated_at',
        '--sort',
        'desc',
        ...stateFlag,
        ...assigneeFlag
      ],
      glabRepoExecOptions(repoPath, connectionId, localGitOptions)
    )
    const data = JSON.parse(stdout) as unknown[]
    return {
      items: data.map((d) => mapGitLabIssueInfo(d as Parameters<typeof mapGitLabIssueInfo>[0]))
    }
  } catch (err) {
    const stderr = err instanceof Error ? err.message : String(err)
    return {
      items: [],
      error: classifyListIssuesError(stderr)
    }
  } finally {
    release()
  }
}

/**
 * Create a new GitLab issue. Uses `glab api` with explicit project path so
 * the call doesn't depend on cwd matching the project the user picked.
 */
export async function createIssue(
  repoPath: string,
  title: string,
  body: string,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<{ ok: true; number: number; url: string } | { ok: false; error: string }> {
  const trimmedTitle = title.trim()
  if (!trimmedTitle) {
    return { ok: false, error: 'Title is required' }
  }
  const knownHosts = await getGlabKnownHosts()
  const { source: projectRef } = await resolveIssueSource(
    repoPath,
    preference,
    knownHosts,
    connectionId,
    localGitOptions
  )
  if (!projectRef) {
    return {
      ok: false,
      error: 'Could not resolve GitLab project for this repository'
    }
  }
  await acquire()
  try {
    const { stdout } = await glabExecFileAsync(
      [
        'api',
        ...glabHostnameArgs(projectRef, connectionId),
        '-X',
        'POST',
        `projects/${encodedProject(projectRef.path)}/issues`,
        '-f',
        `title=${trimmedTitle}`,
        '-f',
        // Why: GitLab uses `description` (not `body`) for issue text.
        `description=${body}`
      ],
      glabRepoExecOptions(repoPath, connectionId, localGitOptions)
    )
    const data = JSON.parse(stdout) as { iid?: number; web_url?: string; url?: string }
    if (typeof data.iid !== 'number') {
      return { ok: false, error: 'Unexpected response from GitLab' }
    }
    return {
      ok: true,
      number: data.iid,
      url: String(data.web_url ?? data.url ?? '')
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  } finally {
    release()
  }
}

/**
 * Update an existing GitLab issue.
 *
 * Why: callers that list through a per-repo issue source preference must
 * mutate the same GitLab project, or identical IIDs on origin/upstream can
 * silently edit the wrong issue.
 */
export async function updateIssue(
  repoPath: string,
  issueNumber: number,
  updates: GitLabIssueUpdate,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRefOverride?: ProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
  const projectRef =
    projectRefOverride ??
    (
      await resolveIssueSource(
        repoPath,
        preference,
        await getGlabKnownHosts(),
        connectionId,
        localGitOptions
      )
    ).source
  if (!projectRef) {
    return {
      ok: false,
      error: 'Could not resolve GitLab project for this repository'
    }
  }

  const repoFlag = projectRef.path
  const errors: string[] = []

  // State change requires a separate command (parallel to github's split).
  if (updates.state) {
    await acquire()
    try {
      const cmd = updates.state === 'closed' ? 'close' : 'reopen'
      await glabExecFileAsync(
        [
          'issue',
          cmd,
          String(issueNumber),
          '-R',
          repoFlag,
          ...glabHostnameArgs(projectRef, connectionId)
        ],
        glabRepoExecOptions(repoPath, connectionId, localGitOptions)
      )
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err)
      // Treat "already closed/reopened" as a no-op (matches gh path).
      if (!stderr.toLowerCase().includes('already')) {
        errors.push(classifyGlabError(stderr).message)
      }
    } finally {
      release()
    }
  }

  if (updates.body !== undefined) {
    await acquire()
    try {
      await glabExecFileAsync(
        [
          'api',
          ...glabHostnameArgs(projectRef, connectionId),
          '-X',
          'PUT',
          `projects/${encodedProject(repoFlag)}/issues/${issueNumber}`,
          '-f',
          `description=${updates.body}`
        ],
        glabRepoExecOptions(repoPath, connectionId, localGitOptions)
      )
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err)
      errors.push(classifyGlabError(stderr).message)
    } finally {
      release()
    }
  }

  // Field edits via `glab issue update`.
  const editArgs: string[] = [
    'issue',
    'update',
    String(issueNumber),
    '-R',
    repoFlag,
    ...glabHostnameArgs(projectRef, connectionId)
  ]
  let hasEditArgs = false

  if (updates.title) {
    editArgs.push('--title', updates.title)
    hasEditArgs = true
  }
  for (const label of updates.addLabels ?? []) {
    editArgs.push('--label', label)
    hasEditArgs = true
  }
  for (const label of updates.removeLabels ?? []) {
    editArgs.push('--unlabel', label)
    hasEditArgs = true
  }
  for (const assignee of updates.addAssignees ?? []) {
    editArgs.push('--assignee', assignee)
    hasEditArgs = true
  }
  for (const assignee of updates.removeAssignees ?? []) {
    editArgs.push('--unassignee', assignee)
    hasEditArgs = true
  }

  if (hasEditArgs) {
    await acquire()
    try {
      await glabExecFileAsync(
        editArgs,
        glabRepoExecOptions(repoPath, connectionId, localGitOptions)
      )
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err)
      errors.push(classifyGlabError(stderr).message)
    } finally {
      release()
    }
  }

  if (errors.length > 0) {
    return { ok: false, error: errors.join('; ') }
  }
  return { ok: true }
}

/**
 * Add a comment (note) to an existing GitLab issue. Mirrors
 * github/addIssueComment.
 */
export async function addIssueComment(
  repoPath: string,
  issueNumber: number,
  body: string,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRefOverride?: ProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitLabCommentResult> {
  const projectRef =
    projectRefOverride ??
    (
      await resolveIssueSource(
        repoPath,
        preference,
        await getGlabKnownHosts(),
        connectionId,
        localGitOptions
      )
    ).source
  if (!projectRef) {
    return {
      ok: false,
      error: 'Could not resolve GitLab project for this repository'
    }
  }
  await acquire()
  try {
    const { stdout } = await glabExecFileAsync(
      [
        'api',
        ...glabHostnameArgs(projectRef, connectionId),
        '-X',
        'POST',
        `projects/${encodedProject(projectRef.path)}/issues/${issueNumber}/notes`,
        '-f',
        `body=${body}`
      ],
      glabRepoExecOptions(repoPath, connectionId, localGitOptions)
    )
    const data = JSON.parse(stdout) as {
      id?: number
      author?: { username?: string; avatar_url?: string; state?: string } | null
      body?: string
      created_at?: string
      // Why: GitLab note responses don't include a per-note web_url; build one
      // from the issue URL. We don't have the issue URL here, so leave blank
      // — the renderer falls back to the issue URL when comment.url is empty.
    }
    const comment: MRComment = {
      id: data.id ?? Date.now(),
      author: data.author?.username ?? 'You',
      authorAvatarUrl: data.author?.avatar_url ?? '',
      body: data.body ?? body,
      createdAt: data.created_at ?? new Date().toISOString(),
      url: '',
      isBot: data.author?.state === 'bot'
    }
    return { ok: true, comment }
  } catch (err) {
    const stderr = err instanceof Error ? err.message : String(err)
    return { ok: false, error: classifyGlabError(stderr).message }
  } finally {
    release()
  }
}

export async function listLabels(
  repoPath: string,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<string[]> {
  const knownHosts = await getGlabKnownHosts()
  const { source: projectRef } = await resolveIssueSource(
    repoPath,
    preference,
    knownHosts,
    connectionId,
    localGitOptions
  )
  if (!projectRef) {
    return []
  }
  await acquire()
  try {
    const { stdout } = await glabExecFileAsync(
      [
        'api',
        ...glabHostnameArgs(projectRef, connectionId),
        '--paginate',
        `projects/${encodedProject(projectRef.path)}/labels`,
        '--jq',
        '.[].name'
      ],
      glabRepoExecOptions(repoPath, connectionId, localGitOptions)
    )
    return stdout
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
  } catch {
    return []
  } finally {
    release()
  }
}

export async function listAssignableUsers(
  repoPath: string,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitLabAssignableUser[]> {
  const knownHosts = await getGlabKnownHosts()
  const { source: projectRef } = await resolveIssueSource(
    repoPath,
    preference,
    knownHosts,
    connectionId,
    localGitOptions
  )
  if (!projectRef) {
    return []
  }
  await acquire()
  try {
    // Why: `members/all` returns project members including those inherited
    // from parent groups — important for projects under a top-level group
    // where assignable users typically come from the group, not the project.
    // --paginate walks every page; --jq emits NDJSON.
    const { stdout } = await glabExecFileAsync(
      [
        'api',
        ...glabHostnameArgs(projectRef, connectionId),
        '--paginate',
        `projects/${encodedProject(projectRef.path)}/members/all?per_page=100`,
        '--jq',
        '.[] | {id, username, name, avatar_url, state}'
      ],
      glabRepoExecOptions(repoPath, connectionId, localGitOptions)
    )
    type RESTMember = {
      id?: number
      username?: string
      name?: string | null
      avatar_url?: string | null
      state?: string | null
    }
    const users: GitLabAssignableUser[] = []
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) {
        continue
      }
      try {
        const user = JSON.parse(trimmed) as RESTMember
        if (user.username) {
          users.push({
            ...(typeof user.id === 'number' ? { id: user.id } : {}),
            username: user.username,
            name: user.name ?? null,
            avatarUrl: user.avatar_url ?? '',
            ...(user.state !== undefined ? { state: user.state } : {})
          })
        }
      } catch {
        // Skip malformed NDJSON lines defensively.
      }
    }
    return users
  } catch {
    return []
  } finally {
    release()
  }
}
