import type { ClassifiedError } from '../../shared/classified-error'
import type {
  GitLabPagedResult,
  GitLabTodo,
  GitLabWorkItem,
  MRListState
} from '../../shared/gitlab-types'
import type { IssueSourcePreference } from '../../shared/repo-types'
import { mapIssueToWorkItem, mapMRToWorkItem } from './mappers'
import {
  acquire,
  classifyListFetchError,
  getGlabKnownHosts,
  getProjectRef,
  glabHostnameArgs,
  glabRepoExecOptions,
  glabExecFileAsync,
  parseGlabJsonList,
  release,
  resolveIssueSource,
  type LocalGitExecOptions,
  type ProjectRef
} from './gl-utils'
import { encodedProject } from './project-path-encoding'
import type { IssueListState } from './issues'
import { listMergeRequests } from './merge-request-list'

export async function getWorkItemByProjectRef(
  repoPath: string,
  projectRef: ProjectRef,
  iid: number,
  type: 'issue' | 'mr',
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitLabWorkItem | null> {
  await acquire()
  try {
    const resource = type === 'mr' ? 'merge_requests' : 'issues'
    const { stdout } = await glabExecFileAsync(
      [
        'api',
        // Why: preserve the pasted URL's explicit host so cwd remotes can't redirect the lookup.
        ...(projectRef.host ? ['--hostname', projectRef.host] : []),
        `projects/${encodedProject(projectRef.path)}/${resource}/${iid}`
      ],
      glabRepoExecOptions(repoPath, connectionId, localGitOptions)
    )
    const data = JSON.parse(stdout)
    if (type === 'mr') {
      return mapMRToWorkItem(data, projectRef.path, projectRef)
    }
    return mapIssueToWorkItem(data, projectRef.path, projectRef)
  } catch {
    return null
  } finally {
    release()
  }
}

function mrStateToIssueState(state: MRListState): IssueListState | null {
  // Why: issues have no 'merged' state; return null so the issues fetch is skipped, not mis-mapped.
  switch (state) {
    case 'opened':
      return 'opened'
    case 'closed':
      return 'closed'
    case 'all':
      return 'all'
    case 'merged':
      return null
  }
}

export async function listWorkItems(
  repoPath: string,
  state: MRListState = 'opened',
  page = 1,
  perPage = 20,
  preference?: IssueSourcePreference,
  query?: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitLabPagedResult<GitLabWorkItem>> {
  const issueState = mrStateToIssueState(state)
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
      items: [],
      page,
      perPage,
      totalCount: 0,
      totalPages: 0,
      error: {
        type: 'not_found',
        message: 'No GitLab project found for this repository.'
      }
    }
  }
  // Why: fan out both reads so latency is the slower of the two, not the sum.
  // Why read the raw issues API (not listIssues): IssueInfo strips updated_at, which the combined sort needs.
  const [mrs, issues] = await Promise.all([
    listMergeRequests(
      repoPath,
      state,
      page,
      perPage,
      preference,
      query,
      connectionId,
      localGitOptions
    ),
    issueState === null
      ? Promise.resolve({
          items: [] as GitLabWorkItem[],
          error: undefined as ClassifiedError | undefined
        })
      : fetchIssuesAsWorkItems(
          repoPath,
          projectRef,
          issueState,
          page,
          perPage,
          query,
          connectionId,
          localGitOptions
        )
  ])
  const merged = [...mrs.items, ...issues.items].sort((a, b) =>
    (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
  )
  // Why: MR-side error wins — issues can be disabled per project, making its error less informative.
  const error: ClassifiedError | undefined = mrs.error ?? issues.error
  return {
    items: merged,
    page,
    perPage,
    // Why: approximate totals — GitLab can't paginate across MRs+issues as one set, so MR totals stand in.
    totalCount: mrs.totalCount,
    totalPages: mrs.totalPages,
    ...(error ? { error } : {})
  }
}

export async function fetchIssuesAsWorkItems(
  repoPath: string,
  projectRef: ProjectRef,
  state: IssueListState,
  page: number,
  perPage: number,
  query?: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<{ items: GitLabWorkItem[]; error: ClassifiedError | undefined }> {
  await acquire()
  try {
    const stateParam = state === 'all' ? '' : `&state=${state}`
    const searchParam = query?.trim() ? `&search=${encodeURIComponent(query.trim())}` : ''
    const { stdout } = await glabExecFileAsync(
      [
        'api',
        ...glabHostnameArgs(projectRef, connectionId),
        `projects/${encodedProject(projectRef.path)}/issues?page=${page}&per_page=${perPage}&order_by=updated_at&sort=desc${stateParam}${searchParam}`
      ],
      glabRepoExecOptions(repoPath, connectionId, localGitOptions)
    )
    const data = parseGlabJsonList<Parameters<typeof mapIssueToWorkItem>[0]>(stdout)
    return {
      items: data.map((d) => mapIssueToWorkItem(d, projectRef.path, projectRef)),
      error: undefined
    }
  } catch (err) {
    return {
      items: [],
      error: classifyListFetchError(err)
    }
  } finally {
    release()
  }
}

/**
 * List the authenticated user's GitLab todos (gitlab.com/dashboard/todos).
 * User-scoped, so cwd is irrelevant; repoPath only satisfies the IPC handler's path-validation guard.
 */
export async function listTodos(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitLabTodo[]> {
  const projectRef = await getProjectRef(
    repoPath,
    await getGlabKnownHosts(connectionId, localGitOptions),
    connectionId,
    localGitOptions
  )
  if (connectionId && !projectRef) {
    return []
  }
  await acquire()
  try {
    // Why: per_page=50 keeps this cross-project view cheap; the UI only shows top-priority todos.
    const { stdout } = await glabExecFileAsync(
      [
        'api',
        ...(projectRef ? glabHostnameArgs(projectRef, connectionId) : []),
        'todos?state=pending&per_page=50'
      ],
      glabRepoExecOptions(repoPath, connectionId, localGitOptions)
    )
    type RESTTodo = {
      id?: number
      action_name?: string
      target_type?: string
      target?: {
        iid?: number
        title?: string
        web_url?: string
      } | null
      target_url?: string
      author?: { username?: string | null; avatar_url?: string | null } | null
      project?: { path_with_namespace?: string } | null
      updated_at?: string
      state?: string
    }
    const data = JSON.parse(stdout) as RESTTodo[]
    return data.map<GitLabTodo>((t) => ({
      id: t.id ?? 0,
      actionName: t.action_name ?? '',
      targetType: t.target_type ?? '',
      targetIid: typeof t.target?.iid === 'number' ? t.target.iid : null,
      targetTitle: t.target?.title ?? '',
      targetUrl: t.target_url ?? t.target?.web_url ?? '',
      projectPath: t.project?.path_with_namespace ?? '',
      authorUsername: t.author?.username ?? '',
      authorAvatarUrl: t.author?.avatar_url ?? '',
      updatedAt: t.updated_at ?? '',
      state: t.state === 'done' ? 'done' : 'pending'
    }))
  } catch {
    // Why: silent empty-list on auth/network failure matches the read-side surface; caller UI signals connectivity.
    return []
  } finally {
    release()
  }
}
