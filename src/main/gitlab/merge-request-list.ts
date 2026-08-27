import type { ListMergeRequestsResult, MRListState } from '../../shared/gitlab-types'
import type { IssueSourcePreference } from '../../shared/repo-types'
import { mapMRToWorkItem } from './mappers'
import {
  acquire,
  classifyListFetchError,
  getGlabKnownHosts,
  glabApiWithHeaders,
  glabHostnameArgs,
  glabRepoExecOptions,
  glabExecFileAsync,
  parseGlabJsonList,
  release,
  resolveIssueSource,
  type LocalGitExecOptions
} from './gl-utils'
import { encodedProject } from './project-path-encoding'

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

/** List merge requests for a project via glab CLI, which handles self-hosted auth and project selection. */
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
  // Why: MRs live on the user's fork (origin); route through the preference resolver so fork workflows share plumbing.
  const { source: projectRef } = await resolveIssueSource(
    repoPath,
    preference,
    knownHosts,
    connectionId,
    localGitOptions
  )
  if (!projectRef) {
    if (connectionId) {
      // Why: SSH-backed repos have no local cwd; a cwd-less glab could resolve an unrelated project.
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
    // Why: fallback — let glab infer the project from cwd when the host isn't in getGlabKnownHosts.
    const stateFlag = mrListStateFlags(state)
    // Why: apply the same search as the API path, else queries are silently ignored on cwd-inferred repos (#6263).
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
      const data = parseGlabJsonList<Parameters<typeof mapMRToWorkItem>[0]>(stdout)
      return {
        items: data.map((d) => mapMRToWorkItem(d, 'unknown')),
        page,
        perPage,
        // Why: the CLI omits x-total headers, so totals are approximate.
        totalCount: data.length,
        totalPages: data.length < perPage ? page : page + 1
      }
    } catch (err) {
      return {
        items: [],
        page,
        perPage,
        totalCount: 0,
        totalPages: 0,
        error: classifyListFetchError(err)
      }
    } finally {
      release()
    }
  }
  // Why: GitLab's API uses an absent state param to mean "any"; drop it for 'all'.
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
    const data = parseGlabJsonList<Parameters<typeof mapMRToWorkItem>[0]>(body)
    return {
      items: data.map((d) => mapMRToWorkItem(d, repoId, projectRef)),
      page,
      perPage,
      totalCount: parseHeaderInt(headers['x-total'], 0),
      // Why: GitLab may omit x-total-pages for 'all' or large per_page; fall back to ceil(total/perPage).
      totalPages:
        parseHeaderInt(headers['x-total-pages'], 0) ||
        Math.max(1, Math.ceil(parseHeaderInt(headers['x-total'], 0) / perPage))
    }
  } catch (err) {
    return {
      items: [],
      page,
      perPage,
      totalCount: 0,
      totalPages: 0,
      error: classifyListFetchError(err)
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
 * Fetch a work item (MR or issue) by explicit project ref + iid + type.
 * Used by the paste-URL flow, where the URL determines the project directly.
 */
