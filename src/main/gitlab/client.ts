/* eslint-disable max-lines -- Why: parallel to src/main/github/client.ts —
co-locating GitLab MR/issue/work-item operations keeps the concurrency
acquire/release pattern obvious across operations. */
import type {
  ClassifiedError,
  GitLabPagedResult,
  GitLabTodo,
  GitLabViewer,
  GitLabWorkItem,
  IssueSourcePreference,
  ListMergeRequestsResult,
  MRComment,
  MRInfo,
  MRListState
} from '../../shared/types'
import { derivePipelineStatus, mapIssueToWorkItem, mapMRInfo, mapMRToWorkItem } from './mappers'
import {
  acquire,
  classifyGlabError,
  classifyListIssuesError,
  getGlabKnownHosts,
  getProjectRef,
  getProjectRefForRemote,
  glabHostnameArgs,
  glabRepoExecOptions,
  glabApiWithHeaders,
  glabExecFileAsync,
  release,
  resolveIssueSource,
  type ProjectRef
} from './gl-utils'
import type { IssueListState } from './issues'

// Why: glab REST API addresses projects by URL-encoded path. Centralized
// so call sites don't forget the slash escapes for nested groups.
function encodedProject(projectPath: string): string {
  return encodeURIComponent(projectPath)
}

/**
 * Get the authenticated GitLab viewer. Mirrors getAuthenticatedViewer
 * from the GitHub client — returns null when glab is unavailable, the
 * user is unauthenticated, or the lookup fails.
 */
export async function getAuthenticatedViewer(): Promise<GitLabViewer | null> {
  await acquire()
  try {
    const { stdout } = await glabExecFileAsync(['api', 'user'])
    const viewer = JSON.parse(stdout) as { username?: string; email?: string | null }
    if (!viewer.username?.trim()) {
      return null
    }
    return {
      username: viewer.username.trim(),
      email: viewer.email?.trim() || null
    }
  } catch {
    return null
  } finally {
    release()
  }
}

/**
 * Resolve a project's full GitLab project ref (host + path). Mirrors
 * github/getRepoSlug. Returns null for non-GitLab remotes.
 */
export async function getProjectSlug(
  repoPath: string,
  connectionId?: string | null
): Promise<ProjectRef | null> {
  const knownHosts = await getGlabKnownHosts()
  return getProjectRef(repoPath, knownHosts, connectionId)
}

/**
 * Fetch a single merge request with the pipeline status rolled up.
 * Returns null when the MR doesn't exist or glab fails — callers
 * decide whether to surface "not found" UI.
 */
export async function getMergeRequest(
  repoPath: string,
  iid: number,
  connectionId?: string | null
): Promise<MRInfo | null> {
  const knownHosts = await getGlabKnownHosts()
  const projectRef = await getProjectRef(repoPath, knownHosts, connectionId)
  await acquire()
  try {
    const args = projectRef
      ? [
          'api',
          ...glabHostnameArgs(projectRef, connectionId),
          `projects/${encodedProject(projectRef.path)}/merge_requests/${iid}`
        ]
      : ['mr', 'view', String(iid), '--output', 'json']
    const { stdout } = await glabExecFileAsync(args, glabRepoExecOptions(repoPath, connectionId))
    const data = JSON.parse(stdout) as Parameters<typeof mapMRInfo>[0] & {
      head_pipeline?: { status?: string } | null
      pipeline?: { status?: string } | null
    }
    // Why: GitLab's MR detail surfaces the head pipeline directly.
    // Older instances expose `pipeline` instead of `head_pipeline` — try
    // both. If neither is set the rollup falls back to neutral.
    const pipelineStatus = derivePipelineStatus(data.head_pipeline ?? data.pipeline ?? null)
    return mapMRInfo(data, pipelineStatus)
  } catch {
    return null
  } finally {
    release()
  }
}

/**
 * Find the merge request whose source branch matches the given branch
 * name. Mirrors github/getPRForBranch — returns the most recently
 * updated MR for the branch, or null when none exists. The branch is the
 * local checkout's current ref (Orca strips refs/heads/ prefix upstream
 * so we don't need to here).
 */
export async function getMergeRequestForBranch(
  repoPath: string,
  branch: string,
  linkedMRIid?: number | null,
  connectionId?: string | null
): Promise<MRInfo | null> {
  const branchName = branch.replace(/^refs\/heads\//, '')
  if (!branchName && linkedMRIid == null) {
    return null
  }
  const knownHosts = await getGlabKnownHosts()
  const projectRef = await getProjectRef(repoPath, knownHosts, connectionId)
  if (!projectRef) {
    return null
  }
  await acquire()
  try {
    if (branchName) {
      const { stdout } = await glabExecFileAsync(
        [
          'api',
          ...glabHostnameArgs(projectRef, connectionId),
          `projects/${encodedProject(projectRef.path)}/merge_requests?source_branch=${encodeURIComponent(branchName)}&order_by=updated_at&sort=desc&per_page=1`
        ],
        glabRepoExecOptions(repoPath, connectionId)
      )
      const data = JSON.parse(stdout) as (Parameters<typeof mapMRInfo>[0] & {
        head_pipeline?: { status?: string } | null
      })[]
      if (Array.isArray(data) && data.length > 0) {
        const raw = data[0]
        const pipelineStatus = derivePipelineStatus(raw.head_pipeline ?? null)
        return mapMRInfo(raw, pipelineStatus)
      }
    }
    if (typeof linkedMRIid !== 'number') {
      return null
    }
    // Why: create-from-MR worktrees may use a fresh local branch name rather
    // than the MR source branch. Fall back to the durable linked iid so the
    // core review status still follows the workspace.
    const { stdout } = await glabExecFileAsync(
      [
        'api',
        ...glabHostnameArgs(projectRef, connectionId),
        `projects/${encodedProject(projectRef.path)}/merge_requests/${linkedMRIid}`
      ],
      glabRepoExecOptions(repoPath, connectionId)
    )
    const raw = JSON.parse(stdout) as Parameters<typeof mapMRInfo>[0] & {
      head_pipeline?: { status?: string } | null
      pipeline?: { status?: string } | null
    }
    const pipelineStatus = derivePipelineStatus(raw.head_pipeline ?? raw.pipeline ?? null)
    return mapMRInfo(raw, pipelineStatus)
  } catch {
    return null
  } finally {
    release()
  }
}

function mrListStateFlags(state: MRListState): string[] {
  switch (state) {
    case 'opened':
      return []
    case 'merged':
      return ['--merged']
    case 'closed':
      return ['--closed']
    case 'all':
      return ['--all']
  }
}

/**
 * List merge requests for a project. Uses glab CLI pagination because
 * it handles self-hosted auth and project selection consistently.
 */
export async function listMergeRequests(
  repoPath: string,
  state: MRListState = 'opened',
  page = 1,
  perPage = 20,
  preference?: IssueSourcePreference,
  query?: string,
  connectionId?: string | null
): Promise<ListMergeRequestsResult> {
  const knownHosts = await getGlabKnownHosts()
  // Why: MRs sit on `origin` in the fork model (the user's fork is where
  // they push branches and submit MRs). Mirror github's `getOwnerRepo`
  // call site by going through the upstream/origin preference resolver
  // so cross-fork workflows reuse the same plumbing.
  const { source: projectRef } = await resolveIssueSource(
    repoPath,
    preference,
    knownHosts,
    connectionId
  )
  if (!projectRef) {
    if (connectionId) {
      // Why: SSH-backed repos have no local cwd for glab to infer from.
      // Running cwd-less could resolve an unrelated local project instead.
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
    // Why: fallback — let glab infer project from cwd, same as listIssues.
    // Used when the repo's remote host is not in getGlabKnownHosts()
    // (e.g. a fresh self-hosted instance), but glab itself can still
    // resolve it from the local git config.
    const stateFlag = mrListStateFlags(state)
    await acquire()
    try {
      const { stdout } = await glabExecFileAsync(
        [
          'mr',
          'list',
          '--output',
          'json',
          '--per-page',
          String(perPage),
          '--page',
          String(page),
          '--order',
          'updated_at',
          '--sort',
          'desc',
          ...stateFlag
        ],
        glabRepoExecOptions(repoPath, connectionId)
      )
      const data = JSON.parse(stdout) as Parameters<typeof mapMRToWorkItem>[0][]
      return {
        items: data.map((d) => mapMRToWorkItem(d, 'unknown')),
        page,
        perPage,
        // Why: the CLI doesn't return x-total headers, so totals are
        // approximate. For the Tasks UI this is acceptable.
        totalCount: data.length,
        totalPages: data.length < perPage ? page : page + 1
      }
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err)
      return {
        items: [],
        page,
        perPage,
        totalCount: 0,
        totalPages: 0,
        error: classifyListIssuesError(stderr)
      }
    } finally {
      release()
    }
  }
  // Why: 'all' is exposed as the picker filter but GitLab's API expects
  // no state param to mean "any state". Drop the param when 'all'.
  const stateParam = state === 'all' ? '' : `&state=${state}`
  const searchParam = query?.trim() ? `&search=${encodeURIComponent(query.trim())}` : ''
  const path =
    `projects/${encodedProject(projectRef.path)}/merge_requests?` +
    `page=${page}&per_page=${perPage}&order_by=updated_at&sort=desc&with_merge_status_recheck=false${stateParam}${searchParam}`
  const repoId = projectRef.path

  await acquire()
  try {
    const { body, headers } = await glabApiWithHeaders(
      [...glabHostnameArgs(projectRef, connectionId), path],
      glabRepoExecOptions(repoPath, connectionId)
    )
    const data = JSON.parse(body) as Parameters<typeof mapMRToWorkItem>[0][]
    return {
      items: data.map((d) => mapMRToWorkItem(d, repoId, projectRef)),
      page,
      perPage,
      totalCount: parseHeaderInt(headers['x-total'], 0),
      // Why: when 'all' state is requested or the per_page is large,
      // GitLab may not include x-total-pages; fall back to ceil(total/perPage).
      totalPages:
        parseHeaderInt(headers['x-total-pages'], 0) ||
        Math.max(1, Math.ceil(parseHeaderInt(headers['x-total'], 0) / perPage))
    }
  } catch (err) {
    const stderr = err instanceof Error ? err.message : String(err)
    return {
      items: [],
      page,
      perPage,
      totalCount: 0,
      totalPages: 0,
      error: classifyListIssuesError(stderr)
    }
  } finally {
    release()
  }
}

function parseHeaderInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback
  }
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * Fetch a work item (MR or issue) given an explicit project ref +
 * iid + type. Mirrors github/getWorkItemByOwnerRepo — used by the
 * paste-URL flow in the picker where the URL determines the project
 * directly rather than going through the local repo's remotes.
 */
export async function getWorkItemByProjectRef(
  repoPath: string,
  projectRef: ProjectRef,
  iid: number,
  type: 'issue' | 'mr',
  connectionId?: string | null
): Promise<GitLabWorkItem | null> {
  await acquire()
  try {
    const resource = type === 'mr' ? 'merge_requests' : 'issues'
    const { stdout } = await glabExecFileAsync(
      [
        'api',
        ...glabHostnameArgs(projectRef, connectionId),
        `projects/${encodedProject(projectRef.path)}/${resource}/${iid}`
      ],
      glabRepoExecOptions(repoPath, connectionId)
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
  // Why: GitLab issues don't have a 'merged' state. When the user is
  // filtering MRs to merged, return null so listWorkItems can skip the
  // issues fetch entirely instead of mis-mapping to opened/closed.
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
  connectionId?: string | null
): Promise<GitLabPagedResult<GitLabWorkItem>> {
  const issueState = mrStateToIssueState(state)
  const knownHosts = await getGlabKnownHosts()
  const { source: projectRef } = await resolveIssueSource(
    repoPath,
    preference,
    knownHosts,
    connectionId
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
  // Why: fan out the two read calls so the response time is the slower
  // of the two, not their sum. Errors classify per-side; an MR-side
  // failure with a successful issues fetch still surfaces issues with
  // an error envelope.
  //
  // Why we don't go through `listIssues` here: that function returns
  // IssueInfo, which deliberately strips the raw glab fields (notably
  // `updated_at`). The combined sort needs updatedAt, so we read the
  // raw issues API directly and run mapIssueToWorkItem against the
  // raw payload instead.
  const [mrs, issues] = await Promise.all([
    listMergeRequests(repoPath, state, page, perPage, preference, query, connectionId),
    issueState === null
      ? Promise.resolve({
          items: [] as GitLabWorkItem[],
          error: undefined as ClassifiedError | undefined
        })
      : fetchIssuesAsWorkItems(repoPath, projectRef, issueState, perPage, query, connectionId)
  ])
  const merged = [...mrs.items, ...issues.items].sort((a, b) =>
    (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
  )
  // Why: combine error envelopes — the renderer's banner cares about
  // any failed fetch, not which one. MR-side error wins because it's
  // strictly more informative than an issues-side error in most
  // permission scenarios (issues can be disabled per project).
  const error: ClassifiedError | undefined = mrs.error ?? issues.error
  return {
    items: merged,
    page,
    perPage,
    // Why: approximate totals — an exact combined-pagination total would
    // require a server-side ordering primitive across two distinct
    // resources, which the GitLab API doesn't offer. MR total is the
    // right direction; the UI's "Page X of Y" reads as a hint, not a
    // strict count.
    totalCount: mrs.totalCount,
    totalPages: mrs.totalPages,
    ...(error ? { error } : {})
  }
}

export async function fetchIssuesAsWorkItems(
  repoPath: string,
  projectRef: ProjectRef,
  state: IssueListState,
  perPage: number,
  query?: string,
  connectionId?: string | null
): Promise<{ items: GitLabWorkItem[]; error: ClassifiedError | undefined }> {
  await acquire()
  try {
    const stateParam = state === 'all' ? '' : `&state=${state}`
    const searchParam = query?.trim() ? `&search=${encodeURIComponent(query.trim())}` : ''
    const { stdout } = await glabExecFileAsync(
      [
        'api',
        ...glabHostnameArgs(projectRef, connectionId),
        `projects/${encodedProject(projectRef.path)}/issues?per_page=${perPage}&order_by=updated_at&sort=desc${stateParam}${searchParam}`
      ],
      glabRepoExecOptions(repoPath, connectionId)
    )
    const data = JSON.parse(stdout) as Parameters<typeof mapIssueToWorkItem>[0][]
    return {
      items: data.map((d) => mapIssueToWorkItem(d, projectRef.path, projectRef)),
      error: undefined
    }
  } catch (err) {
    return {
      items: [],
      error: classifyListIssuesError(err instanceof Error ? err.message : String(err))
    }
  } finally {
    release()
  }
}

/**
 * List the authenticated user's GitLab todos (gitlab.com/dashboard/todos).
 * Cross-project — `glab api todos` is user-scoped so the cwd doesn't
 * affect the result; callers may pass any registered repo path so the
 * IPC handler's path-validation guard has something to check.
 *
 * Why: GitLab's todos surface is the closest GitLab-native analogue of
 * GitHub's notifications/inbox. Surfacing it in Orca lets users start
 * work directly from a mention/assignment without going to gitlab.com
 * first.
 */
export async function listTodos(
  repoPath: string,
  connectionId?: string | null
): Promise<GitLabTodo[]> {
  const projectRef = await getProjectRef(repoPath, await getGlabKnownHosts(), connectionId)
  if (connectionId && !projectRef) {
    return []
  }
  await acquire()
  try {
    // Why: per_page=50 keeps the first-page round-trip small. Pagination
    // is left for a follow-up — most users have <50 pending todos in
    // practice and the UI shows the highest-priority ones first.
    const { stdout } = await glabExecFileAsync(
      [
        'api',
        ...(projectRef ? glabHostnameArgs(projectRef, connectionId) : []),
        '--paginate',
        'todos?state=pending&per_page=50'
      ],
      glabRepoExecOptions(repoPath, connectionId)
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
    // Why: --paginate concatenates JSON arrays (one per page) into a
    // single stream. glab's behavior is to emit them as one JSON array
    // when the endpoint returns arrays — we trust that contract here.
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
    // Why: silent empty-list on auth/network failures matches the rest
    // of the read-side surface (`listLabels`, `listAssignableUsers`).
    // The caller's banner / loading-state UI signals connectivity issues.
    return []
  } finally {
    release()
  }
}

// ── MR mutations ──────────────────────────────────────────────────
// Why: mirror the GitHub-side actions (mergePR, updatePRTitle, close
// via gh issue close, etc.) for the GitLab dialog footer. All take a
// repoPath + iid and resolve the project ref via the existing helper.

async function withProjectRef<T>(
  repoPath: string,
  preference: IssueSourcePreference | undefined,
  connectionId: string | null | undefined,
  explicitProjectRef: ProjectRef | null | undefined,
  fn: (projectRef: ProjectRef, repoFlag: string) => Promise<T>,
  fallback: T
): Promise<T> {
  const projectRef =
    explicitProjectRef ??
    (await resolveIssueSource(repoPath, preference, await getGlabKnownHosts(), connectionId)).source
  if (!projectRef) {
    return fallback
  }
  return fn(projectRef, projectRef.path)
}

export async function closeMR(
  repoPath: string,
  iid: number,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: ProjectRef | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  return withProjectRef<{ ok: true } | { ok: false; error: string }>(
    repoPath,
    preference,
    connectionId,
    projectRef,
    async (projectRef, repoFlag) => {
      await acquire()
      try {
        await glabExecFileAsync(
          [
            'mr',
            'close',
            String(iid),
            '-R',
            repoFlag,
            ...glabHostnameArgs(projectRef, connectionId)
          ],
          glabRepoExecOptions(repoPath, connectionId)
        )
        return { ok: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // Why: glab returns a non-zero exit when the MR is already
        // closed — treat that as success since the desired state is
        // reached.
        if (msg.toLowerCase().includes('already')) {
          return { ok: true }
        }
        return { ok: false, error: msg }
      } finally {
        release()
      }
    },
    { ok: false, error: 'Could not resolve GitLab project for this repository' }
  )
}

export async function reopenMR(
  repoPath: string,
  iid: number,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: ProjectRef | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  return withProjectRef<{ ok: true } | { ok: false; error: string }>(
    repoPath,
    preference,
    connectionId,
    projectRef,
    async (projectRef, repoFlag) => {
      await acquire()
      try {
        await glabExecFileAsync(
          [
            'mr',
            'reopen',
            String(iid),
            '-R',
            repoFlag,
            ...glabHostnameArgs(projectRef, connectionId)
          ],
          glabRepoExecOptions(repoPath, connectionId)
        )
        return { ok: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.toLowerCase().includes('already')) {
          return { ok: true }
        }
        return { ok: false, error: msg }
      } finally {
        release()
      }
    },
    { ok: false, error: 'Could not resolve GitLab project for this repository' }
  )
}

export async function mergeMR(
  repoPath: string,
  iid: number,
  method: 'merge' | 'squash' | 'rebase' = 'merge',
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: ProjectRef | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  return withProjectRef<{ ok: true } | { ok: false; error: string }>(
    repoPath,
    preference,
    connectionId,
    projectRef,
    async (projectRef, repoFlag) => {
      await acquire()
      try {
        // Why: glab mr merge accepts --squash and --rebase flags;
        // omitting both does a regular merge commit. Map our union
        // to the right glab flag.
        const methodFlag =
          method === 'squash' ? ['--squash'] : method === 'rebase' ? ['--rebase'] : []
        await glabExecFileAsync(
          [
            'mr',
            'merge',
            String(iid),
            '-R',
            repoFlag,
            '--yes',
            ...methodFlag,
            ...glabHostnameArgs(projectRef, connectionId)
          ],
          glabRepoExecOptions(repoPath, connectionId)
        )
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      } finally {
        release()
      }
    },
    { ok: false, error: 'Could not resolve GitLab project for this repository' }
  )
}

export async function addMRComment(
  repoPath: string,
  iid: number,
  body: string,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: ProjectRef | null
): Promise<{ ok: true; comment: MRComment } | { ok: false; error: string }> {
  return withProjectRef<{ ok: true; comment: MRComment } | { ok: false; error: string }>(
    repoPath,
    preference,
    connectionId,
    projectRef,
    async (projectRef) => {
      await acquire()
      try {
        const { stdout } = await glabExecFileAsync(
          [
            'api',
            ...glabHostnameArgs(projectRef, connectionId),
            '-X',
            'POST',
            `projects/${encodedProject(projectRef.path)}/merge_requests/${iid}/notes`,
            '-f',
            `body=${body}`
          ],
          glabRepoExecOptions(repoPath, connectionId)
        )
        const data = JSON.parse(stdout) as {
          id?: number
          author?: { username?: string; avatar_url?: string; state?: string } | null
          body?: string
          created_at?: string
        }
        return {
          ok: true,
          comment: {
            id: data.id ?? Date.now(),
            author: data.author?.username ?? 'You',
            authorAvatarUrl: data.author?.avatar_url ?? '',
            body: data.body ?? body,
            createdAt: data.created_at ?? new Date().toISOString(),
            url: '',
            isBot: data.author?.state === 'bot'
          }
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      } finally {
        release()
      }
    },
    { ok: false, error: 'Could not resolve GitLab project for this repository' }
  )
}

export async function updateMR(
  repoPath: string,
  iid: number,
  updates: {
    title?: string
    body?: string
    addLabels?: string[]
    removeLabels?: string[]
  },
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: ProjectRef | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  return withProjectRef<{ ok: true } | { ok: false; error: string }>(
    repoPath,
    preference,
    connectionId,
    projectRef,
    async (projectRef) => {
      const fields: string[] = []
      const title = updates.title?.trim()
      if (updates.title !== undefined) {
        if (!title) {
          return { ok: false, error: 'Title is required' }
        }
        fields.push(`title=${title}`)
      }
      if (updates.body !== undefined) {
        fields.push(`description=${updates.body}`)
      }
      const addLabels = (updates.addLabels ?? []).filter((label) => label.trim().length > 0)
      const removeLabels = (updates.removeLabels ?? []).filter((label) => label.trim().length > 0)
      if (addLabels.length > 0) {
        fields.push(`add_labels=${addLabels.join(',')}`)
      }
      if (removeLabels.length > 0) {
        fields.push(`remove_labels=${removeLabels.join(',')}`)
      }
      if (fields.length === 0) {
        return { ok: true }
      }

      await acquire()
      try {
        await glabExecFileAsync(
          [
            'api',
            ...glabHostnameArgs(projectRef, connectionId),
            '-X',
            'PUT',
            `projects/${encodedProject(projectRef.path)}/merge_requests/${iid}`,
            ...fields.flatMap((field) => ['-f', field])
          ],
          glabRepoExecOptions(repoPath, connectionId)
        )
        return { ok: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, error: classifyGlabError(msg).message }
      } finally {
        release()
      }
    },
    { ok: false, error: 'Could not resolve GitLab project for this repository' }
  )
}

/** Re-export so callers don't need to know the gl-utils module split. */
export { _resetProjectRefCache } from './gl-utils'
export {
  addIssueComment,
  createIssue,
  getIssue,
  listAssignableUsers,
  listIssues,
  listLabels,
  updateIssue
} from './issues'

// Why: surface the upstream-aware project-ref helper so non-issue call
// sites that need the resolved project (e.g. the paste-URL UI) don't
// have to import from gl-utils directly.
export { getProjectRefForRemote }
