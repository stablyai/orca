import type { ClassifiedError } from '../../shared/classified-error'
import type { GitLabCommentResult, GitLabIssueInfo, MRComment } from '../../shared/gitlab-types'
import type { IssueSourcePreference } from '../../shared/repo-types'
import { mapGitLabIssueInfo } from './mappers'
// prettier-ignore
import { glabApiWithHeaders, glabExecFileAsync, acquire, release, getIssueProjectRef, resolveIssueSource, classifyGlabError, classifyListFetchError, getGlabKnownHosts, glabRepoExecOptions, glabHostnameArgs, parseGlabJsonList, parseGlabPaginationHeader, type LocalGitExecOptions, type ProjectRef } from './gl-utils'
import { encodedProject } from './project-path-encoding'
import { codeHostFailure, classifiedFailure } from '../../shared/code-host-failure-copy'

// Distinguish a confirmed empty list from fetch failure.
export type IssueListResult = {
  items: GitLabIssueInfo[]
  /** 0 when the listing failed — the caller keeps its current pager instead of collapsing it. */
  totalPages: number
  error?: ClassifiedError
}

/** Keep heuristic source resolution for durable issue-number links when live list preferences change. */
export async function getIssue(
  repoPath: string,
  issueNumber: number,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitLabIssueInfo | null> {
  const knownHosts = await getGlabKnownHosts(connectionId, localGitOptions)
  const projectRef = await getIssueProjectRef(repoPath, knownHosts, connectionId, localGitOptions)
  // Unresolved SSH projects have no usable local cwd; do not attempt glab repository inference.
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

// GitLab issues have no merged state; all omits the API state parameter.
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
  // Isolate unresolved projects instead of letting cwd inference fail the cross-project aggregate.
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
    // Missing pagination headers may be proxy-stripped; a full page advertises one more probe.
    const probedTotalPages = data.length < perPage ? currentPage : currentPage + 1
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

/** Explicit project paths retain the selected source independently of cwd remotes. */
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
    return codeHostFailure('titleRequired')
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
    return codeHostFailure('gitlab.projectUnresolved')
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
        `description=${body}`
      ],
      glabRepoExecOptions(repoPath, connectionId, localGitOptions)
    )
    const data = JSON.parse(stdout) as { iid?: number; web_url?: string; url?: string }
    if (typeof data.iid !== 'number') {
      return codeHostFailure('gitlab.unexpectedResponse')
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
    return codeHostFailure('gitlab.projectUnresolved')
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
    return classifiedFailure(classifyGlabError(stderr))
  } finally {
    release()
  }
}
