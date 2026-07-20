/* eslint-disable max-lines -- Why: parallel to src/main/github/client.ts —
co-locating GitLab MR/issue/work-item operations keeps the concurrency
acquire/release pattern obvious across operations. */
import type {
  ClassifiedError,
  GitLabAssignableUser,
  GitLabAuthDiagnostic,
  GitLabDiscussionResolveResult,
  GitLabJobTraceResult,
  GitLabPagedResult,
  GitLabPipelineJob,
  GitLabRateLimitSnapshot,
  GitLabMRInlineCommentInput,
  GitLabMRReviewersUpdateResult,
  GitLabRetryJobResult,
  GitLabTodo,
  GitLabViewer,
  GitLabWorkItem,
  GetGitLabRateLimitResult,
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
  parseGlabAuthStatusHosts,
  release,
  resolveIssueSource,
  type LocalGitExecOptions,
  type ProjectRef
} from './gl-utils'
import type { IssueListState } from './issues'
import {
  hasHostedReviewLocalGitOptions,
  getHostedReviewLocalGitOptions,
  type HostedReviewExecutionOptions
} from '../source-control/hosted-review-git-options'

// Why: glab REST API addresses projects by URL-encoded path. Centralized
// so call sites don't forget the slash escapes for nested groups.
function encodedProject(projectPath: string): string {
  return encodeURIComponent(projectPath)
}

const GITLAB_RATE_LIMIT_CACHE_TTL_MS = 30_000
const GITLAB_RATE_LIMIT_CACHE_MAX_ENTRIES = 64
const gitLabRateLimitCache = new Map<string, GitLabRateLimitSnapshot>()

type HostedReviewLocalGitOptions = ReturnType<typeof getHostedReviewLocalGitOptions>

function hostedReviewLocalGitOptionArgs(
  options: HostedReviewExecutionOptions = {}
): [] | [HostedReviewLocalGitOptions] {
  return hasHostedReviewLocalGitOptions(options) ? [getHostedReviewLocalGitOptions(options)] : []
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

export async function diagnoseAuth(): Promise<GitLabAuthDiagnostic> {
  const envTokenInProcess = process.env.GITLAB_TOKEN
    ? 'GITLAB_TOKEN'
    : process.env.GLAB_TOKEN
      ? 'GLAB_TOKEN'
      : null
  try {
    // Why: a host-global diagnostic must not wake an unrelated default WSL distro.
    const { stdout, stderr } = await glabExecFileAsync(['auth', 'status'], {
      allowDefaultWslFallback: false
    })
    const output = `${stdout}\n${stderr}`
    const hosts = parseGlabAuthStatusHosts(output)
    return {
      glabAvailable: true,
      authenticated:
        /logged in|authenticated|token/i.test(output) && !/not logged in/i.test(output),
      hosts,
      activeHost: hosts[0] ?? null,
      envTokenInProcess,
      error: null
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      glabAvailable: !/ENOENT|not found|spawn/i.test(message),
      authenticated: false,
      hosts: [],
      activeHost: null,
      envTokenInProcess,
      error: message
    }
  }
}

function parseRateLimitHeader(
  headers: Record<string, string>,
  keys: readonly string[]
): number | null {
  for (const key of keys) {
    const parsed = Number.parseInt(headers[key], 10)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return null
}

function parseRateLimitResetAt(headers: Record<string, string>): number | null {
  const numeric = parseRateLimitHeader(headers, ['ratelimit-reset', 'x-ratelimit-reset'])
  if (numeric !== null) {
    return numeric
  }
  const resetTime = headers['ratelimit-resettime'] ?? headers['x-ratelimit-resettime']
  if (!resetTime) {
    return null
  }
  const millis = Date.parse(resetTime)
  return Number.isFinite(millis) ? Math.floor(millis / 1000) : null
}

function parseGitLabRateLimitSnapshot(
  headers: Record<string, string>,
  host: string | null
): GitLabRateLimitSnapshot {
  const limit = parseRateLimitHeader(headers, ['ratelimit-limit', 'x-ratelimit-limit'])
  const remaining = parseRateLimitHeader(headers, ['ratelimit-remaining', 'x-ratelimit-remaining'])
  const resetAt = parseRateLimitResetAt(headers)
  return {
    host,
    fetchedAt: Date.now(),
    rest:
      limit === null && remaining === null && resetAt === null
        ? null
        : {
            limit: limit ?? 0,
            remaining: remaining ?? 0,
            resetAt
          }
  }
}

/** @internal — test-only */
export function _resetGitLabRateLimitCache(): void {
  gitLabRateLimitCache.clear()
}

/** @internal — test-only */
export function _getGitLabRateLimitCacheSize(): number {
  return gitLabRateLimitCache.size
}

function pruneGitLabRateLimitCache(now = Date.now()): void {
  for (const [cacheKey, snapshot] of gitLabRateLimitCache) {
    if (now - snapshot.fetchedAt >= GITLAB_RATE_LIMIT_CACHE_TTL_MS) {
      gitLabRateLimitCache.delete(cacheKey)
    }
  }
  while (gitLabRateLimitCache.size > GITLAB_RATE_LIMIT_CACHE_MAX_ENTRIES) {
    const oldestKey = gitLabRateLimitCache.keys().next().value
    if (oldestKey === undefined) {
      break
    }
    gitLabRateLimitCache.delete(oldestKey)
  }
}

function rememberGitLabRateLimitSnapshot(
  cacheKey: string,
  snapshot: GitLabRateLimitSnapshot
): void {
  pruneGitLabRateLimitCache()
  // Why: self-managed GitLab hostnames come from repo config; keep this
  // process cache bounded even across many transient hosts.
  gitLabRateLimitCache.delete(cacheKey)
  gitLabRateLimitCache.set(cacheKey, snapshot)
  pruneGitLabRateLimitCache()
}

export async function getRateLimit(options?: {
  force?: boolean
  host?: string | null
}): Promise<GetGitLabRateLimitResult> {
  const host = options?.host?.trim() || null
  const cacheKey = host ?? 'default'
  pruneGitLabRateLimitCache()
  const cached = gitLabRateLimitCache.get(cacheKey)
  if (!options?.force && cached && Date.now() - cached.fetchedAt < GITLAB_RATE_LIMIT_CACHE_TTL_MS) {
    return { ok: true, snapshot: cached }
  }

  await acquire()
  try {
    // Why: GitLab.com and self-managed GitLab instances expose REST budget
    // headers inconsistently. Query a cheap authenticated endpoint and report
    // the headers when present; a null bucket means this host omitted them.
    const args = host ? ['--hostname', host, 'user'] : ['user']
    const { headers } = await glabApiWithHeaders(args)
    const snapshot = parseGitLabRateLimitSnapshot(headers, host)
    rememberGitLabRateLimitSnapshot(cacheKey, snapshot)
    return { ok: true, snapshot }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
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
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<ProjectRef | null> {
  const localGitArgs = hostedReviewLocalGitOptionArgs(options)
  const knownHosts = await getGlabKnownHosts(connectionId, localGitArgs[0])
  return getProjectRef(repoPath, knownHosts, connectionId, ...localGitArgs)
}

/**
 * Fetch a single merge request with the pipeline status rolled up.
 * Returns null when the MR doesn't exist or glab fails — callers
 * decide whether to surface "not found" UI.
 */
export async function getMergeRequest(
  repoPath: string,
  iid: number,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<MRInfo | null> {
  const localGitArgs = hostedReviewLocalGitOptionArgs(options)
  const localGitOptions = localGitArgs[0] ?? {}
  const knownHosts = await getGlabKnownHosts(connectionId, localGitOptions)
  const projectRef = await getProjectRef(repoPath, knownHosts, connectionId, ...localGitArgs)
  await acquire()
  try {
    const args = projectRef
      ? [
          'api',
          ...glabHostnameArgs(projectRef, connectionId),
          `projects/${encodedProject(projectRef.path)}/merge_requests/${iid}`
        ]
      : ['mr', 'view', String(iid), '--output', 'json']
    const { stdout } = await glabExecFileAsync(
      args,
      glabRepoExecOptions(repoPath, connectionId, localGitOptions)
    )
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
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {},
  // Why: the existing-review lookup behind Create must distinguish a real glab
  // transport/auth failure from an accepted "no MR". When true, a failed lookup
  // throws instead of collapsing to null so callers never report false not_found.
  throwOnFailure = false
): Promise<MRInfo | null> {
  const branchName = branch.replace(/^refs\/heads\//, '')
  if (!branchName && linkedMRIid == null) {
    return null
  }
  const localGitArgs = hostedReviewLocalGitOptionArgs(options)
  const localGitOptions = localGitArgs[0] ?? {}
  const knownHosts = await getGlabKnownHosts(connectionId, localGitOptions)
  const projectRef = await getProjectRef(repoPath, knownHosts, connectionId, ...localGitArgs)
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
        glabRepoExecOptions(repoPath, connectionId, localGitOptions)
      )
      const data = JSON.parse(stdout) as (Parameters<typeof mapMRInfo>[0] & {
        head_pipeline?: { status?: string } | null
        pipeline?: { status?: string } | null
      })[]
      if (Array.isArray(data) && data.length > 0) {
        const raw = data[0]
        // Why: older GitLab list payloads expose `pipeline` instead of
        // `head_pipeline`, matching the detail endpoint compatibility path.
        const pipelineStatus = derivePipelineStatus(raw.head_pipeline ?? raw.pipeline ?? null)
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
      glabRepoExecOptions(repoPath, connectionId, localGitOptions)
    )
    const raw = JSON.parse(stdout) as Parameters<typeof mapMRInfo>[0] & {
      head_pipeline?: { status?: string } | null
      pipeline?: { status?: string } | null
    }
    const pipelineStatus = derivePipelineStatus(raw.head_pipeline ?? raw.pipeline ?? null)
    return mapMRInfo(raw, pipelineStatus)
  } catch (error) {
    if (throwOnFailure) {
      throw error
    }
    return null
  } finally {
    release()
  }
}

/**
 * Existing-review lookup that surfaces glab transport/auth failures instead of
 * collapsing them to null, so a failed lookup becomes
 * `reviewLookupOutcome: 'unavailable'` rather than a false "No merge request found".
 */
export function getMergeRequestForBranchOrThrow(
  repoPath: string,
  branch: string,
  linkedMRIid?: number | null,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<MRInfo | null> {
  return getMergeRequestForBranch(repoPath, branch, linkedMRIid, connectionId, options, true)
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
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<ListMergeRequestsResult> {
  const knownHosts = await getGlabKnownHosts(connectionId, localGitOptions)
  // Why: MRs sit on `origin` in the fork model (the user's fork is where
  // they push branches and submit MRs). Mirror github's `getOwnerRepo`
  // call site by going through the upstream/origin preference resolver
  // so cross-fork workflows reuse the same plumbing.
  const { source: projectRef } = await resolveIssueSource(
    repoPath,
    preference,
    knownHosts,
    connectionId,
    localGitOptions
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
    // Used when the repo's remote host is not in getGlabKnownHosts(connectionId)
    // (e.g. a fresh self-hosted instance), but glab itself can still
    // resolve it from the local git config.
    const stateFlag = mrListStateFlags(state)
    // Why: the cwd-inferred fallback must honor the same search the API path
    // does, otherwise typing a query against a self-hosted / unresolved-projectRef
    // repo silently returns the unfiltered list (the original #6263 symptom).
    const searchFlag = query?.trim() ? ['--search', query.trim()] : []
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
          ...stateFlag,
          ...searchFlag
        ],
        glabRepoExecOptions(repoPath, connectionId, localGitOptions)
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
      glabRepoExecOptions(repoPath, connectionId, localGitOptions)
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
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitLabWorkItem | null> {
  await acquire()
  try {
    const resource = type === 'mr' ? 'merge_requests' : 'issues'
    const { stdout } = await glabExecFileAsync(
      [
        'api',
        // Why: pasted GitLab URLs carry an explicit host; preserve it even for
        // local/runtime-local repos so cwd remotes cannot redirect the lookup.
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
    // Why: per_page=50 keeps this user-scoped cross-project view cheap. The UI
    // shows the highest-priority todos first, so avoid walking every pending
    // todo page from large GitLab accounts.
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
  fallback: T,
  localGitOptions: LocalGitExecOptions = {}
): Promise<T> {
  const projectRef =
    explicitProjectRef ??
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
    return fallback
  }
  return fn(projectRef, projectRef.path)
}

export async function closeMR(
  repoPath: string,
  iid: number,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: ProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
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
          glabRepoExecOptions(repoPath, connectionId, localGitOptions)
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
    { ok: false, error: 'Could not resolve GitLab project for this repository' },
    localGitOptions
  )
}

export async function reopenMR(
  repoPath: string,
  iid: number,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: ProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
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
          glabRepoExecOptions(repoPath, connectionId, localGitOptions)
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
    { ok: false, error: 'Could not resolve GitLab project for this repository' },
    localGitOptions
  )
}

export async function mergeMR(
  repoPath: string,
  iid: number,
  method: 'merge' | 'squash' | 'rebase' = 'merge',
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: ProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
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
          glabRepoExecOptions(repoPath, connectionId, localGitOptions)
        )
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      } finally {
        release()
      }
    },
    { ok: false, error: 'Could not resolve GitLab project for this repository' },
    localGitOptions
  )
}

export async function addMRComment(
  repoPath: string,
  iid: number,
  body: string,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: ProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
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
          glabRepoExecOptions(repoPath, connectionId, localGitOptions)
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
    { ok: false, error: 'Could not resolve GitLab project for this repository' },
    localGitOptions
  )
}

export async function addMRInlineComment(
  repoPath: string,
  iid: number,
  input: GitLabMRInlineCommentInput,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: ProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<{ ok: true; comment: MRComment } | { ok: false; error: string }> {
  return withProjectRef<{ ok: true; comment: MRComment } | { ok: false; error: string }>(
    repoPath,
    preference,
    connectionId,
    projectRef,
    async (projectRef) => {
      const body = input.body.trim()
      if (!body) {
        return { ok: false, error: 'Comment body is required' }
      }
      await acquire()
      try {
        const oldPath = input.oldPath ?? input.path
        const { stdout } = await glabExecFileAsync(
          [
            'api',
            ...glabHostnameArgs(projectRef, connectionId),
            '-X',
            'POST',
            `projects/${encodedProject(projectRef.path)}/merge_requests/${iid}/discussions`,
            '-f',
            `body=${body}`,
            '-f',
            'position[position_type]=text',
            '-f',
            `position[base_sha]=${input.baseSha}`,
            '-f',
            `position[start_sha]=${input.startSha}`,
            '-f',
            `position[head_sha]=${input.headSha}`,
            '-f',
            `position[old_path]=${oldPath}`,
            '-f',
            `position[new_path]=${input.path}`,
            '-f',
            `position[new_line]=${input.line}`
          ],
          glabRepoExecOptions(repoPath, connectionId, localGitOptions)
        )
        const data = JSON.parse(stdout) as {
          id?: string
          notes?: {
            id?: number
            author?: { username?: string; avatar_url?: string; state?: string } | null
            body?: string
            created_at?: string
            position?: { new_path?: string; new_line?: number } | null
          }[]
        }
        const note = data.notes?.[0]
        return {
          ok: true,
          comment: {
            id: note?.id ?? Date.now(),
            author: note?.author?.username ?? 'You',
            authorAvatarUrl: note?.author?.avatar_url ?? '',
            body: note?.body ?? body,
            createdAt: note?.created_at ?? new Date().toISOString(),
            url: '',
            threadId: data.id,
            isResolved: false,
            isBot: note?.author?.state === 'bot',
            path: note?.position?.new_path ?? input.path,
            line: note?.position?.new_line ?? input.line
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, error: classifyGlabError(msg).message }
      } finally {
        release()
      }
    },
    { ok: false, error: 'Could not resolve GitLab project for this repository' },
    localGitOptions
  )
}

export async function resolveMRDiscussion(
  repoPath: string,
  iid: number,
  discussionId: string,
  resolved: boolean,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: ProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitLabDiscussionResolveResult> {
  return withProjectRef<GitLabDiscussionResolveResult>(
    repoPath,
    preference,
    connectionId,
    projectRef,
    async (projectRef) => {
      const trimmedDiscussionId = discussionId.trim()
      if (!trimmedDiscussionId) {
        return { ok: false, error: 'Discussion id is required' }
      }
      await acquire()
      try {
        // Why: GitLab resolves/reopens the whole discussion thread, not a single
        // note; this mirrors GitHub's thread-level resolve mutation.
        await glabExecFileAsync(
          [
            'api',
            ...glabHostnameArgs(projectRef, connectionId),
            '-X',
            'PUT',
            `projects/${encodedProject(projectRef.path)}/merge_requests/${iid}/discussions/${encodeURIComponent(trimmedDiscussionId)}`,
            '-f',
            `resolved=${resolved ? 'true' : 'false'}`
          ],
          glabRepoExecOptions(repoPath, connectionId, localGitOptions)
        )
        return { ok: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, error: classifyGlabError(msg).message }
      } finally {
        release()
      }
    },
    { ok: false, error: 'Could not resolve GitLab project for this repository' },
    localGitOptions
  )
}

function mapRetriedPipelineJob(
  data: {
    id?: number
    pipeline?: { id?: number | null } | null
    name?: string
    stage?: string
    status?: string
    web_url?: string
    duration?: number | null
  },
  fallbackJobId: number
): GitLabPipelineJob {
  return {
    id: data.id ?? fallbackJobId,
    ...(typeof data.pipeline?.id === 'number' ? { pipelineId: data.pipeline.id } : {}),
    name: data.name ?? '',
    stage: data.stage ?? '',
    status: data.status ?? '',
    webUrl: data.web_url ?? '',
    duration: typeof data.duration === 'number' ? data.duration : null
  }
}

function mapGitLabReviewer(raw: {
  id?: number
  username?: string | null
  name?: string | null
  avatar_url?: string | null
  state?: string | null
}): GitLabAssignableUser | null {
  if (!raw.username) {
    return null
  }
  return {
    ...(typeof raw.id === 'number' ? { id: raw.id } : {}),
    username: raw.username,
    name: raw.name ?? null,
    avatarUrl: raw.avatar_url ?? '',
    ...(raw.state !== undefined ? { state: raw.state } : {})
  }
}

export async function updateMRReviewers(
  repoPath: string,
  iid: number,
  reviewerIds: number[],
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: ProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitLabMRReviewersUpdateResult> {
  return withProjectRef<GitLabMRReviewersUpdateResult>(
    repoPath,
    preference,
    connectionId,
    projectRef,
    async (projectRef) => {
      await acquire()
      try {
        const fields =
          reviewerIds.length > 0
            ? reviewerIds.flatMap((id) => ['-f', `reviewer_ids[]=${id}`])
            : ['-f', 'reviewer_ids=']
        const { stdout } = await glabExecFileAsync(
          [
            'api',
            ...glabHostnameArgs(projectRef, connectionId),
            '-X',
            'PUT',
            `projects/${encodedProject(projectRef.path)}/merge_requests/${iid}`,
            ...fields
          ],
          glabRepoExecOptions(repoPath, connectionId, localGitOptions)
        )
        const data = JSON.parse(stdout) as { reviewers?: Parameters<typeof mapGitLabReviewer>[0][] }
        return {
          ok: true,
          reviewers: (data.reviewers ?? [])
            .map(mapGitLabReviewer)
            .filter((u): u is GitLabAssignableUser => !!u)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, error: classifyGlabError(msg).message }
      } finally {
        release()
      }
    },
    { ok: false, error: 'Could not resolve GitLab project for this repository' },
    localGitOptions
  )
}

export async function getJobTrace(
  repoPath: string,
  jobId: number,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: ProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitLabJobTraceResult> {
  return withProjectRef<GitLabJobTraceResult>(
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
            `projects/${encodedProject(projectRef.path)}/jobs/${jobId}/trace`
          ],
          glabRepoExecOptions(repoPath, connectionId, localGitOptions)
        )
        return { ok: true, trace: stdout }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, error: classifyGlabError(msg).message }
      } finally {
        release()
      }
    },
    { ok: false, error: 'Could not resolve GitLab project for this repository' },
    localGitOptions
  )
}

export async function retryJob(
  repoPath: string,
  jobId: number,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: ProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitLabRetryJobResult> {
  return withProjectRef<GitLabRetryJobResult>(
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
            `projects/${encodedProject(projectRef.path)}/jobs/${jobId}/retry`
          ],
          glabRepoExecOptions(repoPath, connectionId, localGitOptions)
        )
        const trimmed = stdout.trim()
        return {
          ok: true,
          ...(trimmed ? { job: mapRetriedPipelineJob(JSON.parse(trimmed), jobId) } : {})
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, error: classifyGlabError(msg).message }
      } finally {
        release()
      }
    },
    { ok: false, error: 'Could not resolve GitLab project for this repository' },
    localGitOptions
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
  projectRef?: ProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
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
          glabRepoExecOptions(repoPath, connectionId, localGitOptions)
        )
        return { ok: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, error: classifyGlabError(msg).message }
      } finally {
        release()
      }
    },
    { ok: false, error: 'Could not resolve GitLab project for this repository' },
    localGitOptions
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
