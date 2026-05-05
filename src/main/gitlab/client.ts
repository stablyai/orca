/* eslint-disable max-lines -- Why: parallel to src/main/github/client.ts —
co-locating GitLab MR/issue/work-item operations keeps the concurrency
acquire/release pattern obvious across operations. */
import type {
  GitLabViewer,
  GitLabWorkItem,
  IssueSourcePreference,
  ListMergeRequestsResult,
  MRInfo,
  MRListState
} from '../../shared/types'
import { derivePipelineStatus, mapIssueToWorkItem, mapMRInfo, mapMRToWorkItem } from './mappers'
import {
  acquire,
  classifyListIssuesError,
  getGlabKnownHosts,
  getProjectRef,
  getProjectRefForRemote,
  glabApiWithHeaders,
  glabExecFileAsync,
  release,
  resolveIssueSource,
  type ProjectRef
} from './gl-utils'

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
export async function getProjectSlug(repoPath: string): Promise<ProjectRef | null> {
  const knownHosts = await getGlabKnownHosts()
  return getProjectRef(repoPath, knownHosts)
}

/**
 * Fetch a single merge request with the pipeline status rolled up.
 * Returns null when the MR doesn't exist or glab fails — callers
 * decide whether to surface "not found" UI.
 */
export async function getMergeRequest(repoPath: string, iid: number): Promise<MRInfo | null> {
  const knownHosts = await getGlabKnownHosts()
  const projectRef = await getProjectRef(repoPath, knownHosts)
  await acquire()
  try {
    const args = projectRef
      ? ['api', `projects/${encodedProject(projectRef.path)}/merge_requests/${iid}`]
      : ['mr', 'view', String(iid), '--output', 'json']
    const { stdout } = await glabExecFileAsync(args, { cwd: repoPath })
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
 * updated open MR for the branch, or null when none exists. The branch
 * is the local checkout's current ref (Orca strips refs/heads/ prefix
 * upstream so we don't need to here).
 */
export async function getMergeRequestForBranch(
  repoPath: string,
  branch: string
): Promise<MRInfo | null> {
  const branchName = branch.replace(/^refs\/heads\//, '')
  if (!branchName) {
    return null
  }
  const knownHosts = await getGlabKnownHosts()
  const projectRef = await getProjectRef(repoPath, knownHosts)
  if (!projectRef) {
    return null
  }
  await acquire()
  try {
    const { stdout } = await glabExecFileAsync(
      [
        'api',
        `projects/${encodedProject(projectRef.path)}/merge_requests?source_branch=${encodeURIComponent(branchName)}&state=opened&order_by=updated_at&sort=desc&per_page=1`
      ],
      { cwd: repoPath }
    )
    const data = JSON.parse(stdout) as (Parameters<typeof mapMRInfo>[0] & {
      head_pipeline?: { status?: string } | null
    })[]
    if (!Array.isArray(data) || data.length === 0) {
      return null
    }
    const raw = data[0]
    const pipelineStatus = derivePipelineStatus(raw.head_pipeline ?? null)
    return mapMRInfo(raw, pipelineStatus)
  } catch {
    return null
  } finally {
    release()
  }
}

/**
 * List merge requests for a project with strict pagination. Returns
 * total counts pulled from X-Total / X-Total-Pages response headers so
 * callers can render "Page X of Y" UIs.
 */
export async function listMergeRequests(
  repoPath: string,
  state: MRListState = 'opened',
  page = 1,
  perPage = 20,
  preference?: IssueSourcePreference
): Promise<ListMergeRequestsResult> {
  const knownHosts = await getGlabKnownHosts()
  // Why: MRs sit on `origin` in the fork model (the user's fork is where
  // they push branches and submit MRs). Mirror github's `getOwnerRepo`
  // call site by going through the upstream/origin preference resolver
  // so cross-fork workflows reuse the same plumbing.
  const { source: projectRef } = await resolveIssueSource(repoPath, preference, knownHosts)
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
  // Why: 'all' is exposed as the picker filter but GitLab's API expects
  // no state param to mean "any state". Drop the param when 'all'.
  const stateParam = state === 'all' ? '' : `&state=${state}`
  const path =
    `projects/${encodedProject(projectRef.path)}/merge_requests?` +
    `page=${page}&per_page=${perPage}&order_by=updated_at&sort=desc&with_merge_status_recheck=false${stateParam}`
  const repoId = projectRef.path

  await acquire()
  try {
    const { body, headers } = await glabApiWithHeaders([path], { cwd: repoPath })
    const data = JSON.parse(body) as Parameters<typeof mapMRToWorkItem>[0][]
    return {
      items: data.map((d) => mapMRToWorkItem(d, repoId)),
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
  type: 'issue' | 'mr'
): Promise<GitLabWorkItem | null> {
  await acquire()
  try {
    const resource = type === 'mr' ? 'merge_requests' : 'issues'
    const { stdout } = await glabExecFileAsync(
      ['api', `projects/${encodedProject(projectRef.path)}/${resource}/${iid}`],
      { cwd: repoPath }
    )
    const data = JSON.parse(stdout)
    if (type === 'mr') {
      return mapMRToWorkItem(data, projectRef.path)
    }
    return mapIssueToWorkItem(data, projectRef.path)
  } catch {
    return null
  } finally {
    release()
  }
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
