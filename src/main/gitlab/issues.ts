import type { ClassifiedError } from '../../shared/classified-error'
import type { GitLabCommentResult, GitLabIssueInfo, MRComment } from '../../shared/gitlab-types'
import type { IssueSourcePreference } from '../../shared/repo-types'
import { mapGitLabIssueInfo } from './mappers'
// prettier-ignore
import { glabApiWithHeaders, glabExecFileAsync, acquire, release, getIssueProjectRef, resolveIssueSource, classifyGlabError, classifyListFetchError, getGlabKnownHosts, glabRepoExecOptions, glabHostnameArgs, parseGlabJsonList, parseGlabPaginationHeader, type LocalGitExecOptions, type ProjectRef } from './gl-utils'
import { encodedProject } from './project-path-encoding'

// Why: parallel to GitHub's IssueListResult — distinguishes a successful-
// empty listing from a failed fetch.
export type IssueListResult = {
  items: GitLabIssueInfo[]
  /** 0 when the listing failed — the caller keeps its current pager instead of collapsing it. */
  totalPages: number
  error?: ClassifiedError
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
  const knownHosts = await getGlabKnownHosts(connectionId, localGitOptions)
  const projectRef = await getIssueProjectRef(repoPath, knownHosts, connectionId, localGitOptions)
  // Why: don't fall back to a cwd-inferred `glab issue view` when the project
  // can't be resolved — on an SSH connection cwd is not the repo dir, so glab
  // hits a non-repo dir and fails with `git: exit status 128`. Return null
  // (the caller already treats a missing project as "no issue") instead of
  // spawning a doomed cwd-dependent call.
  if (!projectRef) {
    return null
  }
  await acquire()
  try {
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
  localGitOptions: LocalGitExecOptions = {},
  page = 1
): Promise<IssueListResult> {
  const currentPage = Number.isFinite(page) ? Math.max(1, Math.trunc(page)) : 1
  const perPage = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : 20
  const knownHosts = await getGlabKnownHosts(connectionId, localGitOptions)
  const { source: projectRef } = await resolveIssueSource(
    repoPath,
    preference,
    knownHosts,
    connectionId,
    localGitOptions
  )
  // Why: when the project can't be resolved we must NOT fall back to an
  // unscoped `glab issue list` that infers the project from cwd. For a repo
  // on an SSH connection there is no local cwd matching the repo, so glab
  // runs git resolution in a non-repo dir and fails with `git: exit status
  // 128`. In an "All projects" aggregate one such failure must not sink the
  // whole panel — return a structured, isolated result so the resolvable
  // projects still load.
  if (!projectRef) {
    return {
      items: [],
      totalPages: 0,
      error: {
        type: 'not_found',
        message: 'Could not resolve a GitLab project for this repository.'
      }
    }
  }
  await acquire()
  try {
    const stateParam = state === 'all' ? '' : `&state=${state}`
    const scopeParam = assignee === '@me' ? '&scope=assigned_to_me' : ''
    const { body, headers } = await glabApiWithHeaders(
      [
        ...glabHostnameArgs(projectRef, connectionId),
        `projects/${encodedProject(projectRef.path)}/issues?page=${currentPage}&per_page=${perPage}&order_by=updated_at&sort=desc${stateParam}${scopeParam}`
      ],
      glabRepoExecOptions(repoPath, connectionId, localGitOptions)
    )
    const data = parseGlabJsonList<Record<string, unknown>>(body)
    const headerTotalCount = parseGlabPaginationHeader(headers['x-total'], 0)
    // Why: a proxy can strip both headers, so a full page advertises one more to probe (#13357);
    // TaskPage retreats if that probe comes back empty.
    const probedTotalPages = data.length < perPage ? currentPage : currentPage + 1
    // Why: GitLab's project issues endpoint returns true issues only
    // (MRs are a separate endpoint), so no equivalent of GitHub's
    // pull_request filter is needed here.
    return {
      items: data.map((d) => mapGitLabIssueInfo(d as Parameters<typeof mapGitLabIssueInfo>[0])),
      totalPages:
        parseGlabPaginationHeader(headers['x-total-pages'], 1) ??
        (headerTotalCount === undefined
          ? probedTotalPages
          : Math.max(1, Math.ceil(headerTotalCount / perPage)))
    }
  } catch (err) {
    return {
      items: [],
      totalPages: 0,
      error: classifyListFetchError(err)
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
  const knownHosts = await getGlabKnownHosts(connectionId, localGitOptions)
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
        await getGlabKnownHosts(connectionId, localGitOptions),
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
