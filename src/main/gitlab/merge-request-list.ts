import type {
  GitLabMRInvolvement,
  ListMergeRequestsResult,
  MRListState
} from '../../shared/gitlab-types'
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
  parseGlabPaginationHeader,
  release,
  resolveIssueSource,
  type LocalGitExecOptions
} from './gl-utils'
import { encodedProject } from './project-path-encoding'
import { readGlabViewer } from './gitlab-auth-and-rate-limit'
import { isTaskRepositoryIneligible } from '../git/task-repository-eligibility'

const INVOLVEMENT_PARAM: Record<GitLabMRInvolvement, string> = {
  authored: 'author_id',
  reviewing: 'reviewer_id'
}

const SIGN_IN_REQUIRED_MESSAGE =
  "GitLab isn't signed in here, so Orca can't filter merge requests by you. Run glab auth login in this environment, then refresh."

class GitLabSignInRequiredError extends Error {}

// A bare "401" would also match a port or host in the request URL of a network failure.
const SIGNED_OUT_LOOKUP_FAILURE =
  /\b401 unauthorized\b|http 401\b|not logged|not authenticated|no token/

function isSignedOutLookupFailure(err: unknown): boolean {
  return SIGNED_OUT_LOOKUP_FAILURE.test(
    (err instanceof Error ? err.message : String(err)).toLowerCase()
  )
}

async function involvementFilterParam(
  involvement: GitLabMRInvolvement,
  hostArgs: string[],
  options: Parameters<typeof glabExecFileAsync>[1]
): Promise<string> {
  const { id: viewerId } = await readGlabViewer(hostArgs, options).catch((err: unknown) => {
    throw isSignedOutLookupFailure(err) ? new GitLabSignInRequiredError() : err
  })
  if (typeof viewerId !== 'number' || !Number.isSafeInteger(viewerId) || viewerId <= 0) {
    throw new Error('Could not identify the signed-in GitLab user.')
  }
  return `&${INVOLVEMENT_PARAM[involvement]}=${viewerId}`
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

export async function listMergeRequests(
  repoPath: string,
  state: MRListState = 'opened',
  page = 1,
  perPage = 20,
  preference?: IssueSourcePreference,
  query?: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {},
  { involvement }: { involvement?: GitLabMRInvolvement } = {}
): Promise<ListMergeRequestsResult> {
  const knownHosts = await getGlabKnownHosts(connectionId, localGitOptions)
  // Resolve the same preference-selected project as issue listings.
  const { source: projectRef } = await resolveIssueSource(
    repoPath,
    preference,
    knownHosts,
    connectionId,
    localGitOptions
  )
  if (!projectRef) {
    if (await isTaskRepositoryIneligible(repoPath, 'gitlab', connectionId, localGitOptions)) {
      return { items: [], page, perPage, totalCount: 0, totalPages: 0 }
    }
    if (involvement) {
      // Before the SSH not_found: the task page hides that type, so the empty list would read as "none of yours".
      return {
        items: [],
        page,
        perPage,
        totalCount: 0,
        totalPages: 0,
        error: {
          type: 'unknown',
          message:
            "Orca couldn't identify this repository's GitLab project, so it can't filter its merge requests by you."
        }
      }
    }
    if (connectionId) {
      // Without local cwd, an unresolved SSH project could become an unrelated glab repository.
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
    // Local compatibility can infer a project omitted from authenticated known hosts.
    const stateFlag = mrListStateFlags(state)
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
        // CLI listings omit total headers; infer whether another page may exist.
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
  const stateParam = state === 'all' ? '' : `&state=${state}`
  const searchParam = query?.trim() ? `&search=${encodeURIComponent(query.trim())}` : ''
  const path =
    `projects/${encodedProject(projectRef.path)}/merge_requests?` +
    `page=${page}&per_page=${perPage}&order_by=updated_at&sort=desc&with_merge_status_recheck=false${stateParam}${searchParam}`
  const repoId = projectRef.path
  const execOptions = glabRepoExecOptions(repoPath, connectionId, localGitOptions)
  // A filtered list pins the project's host so the user lookup and the list share one account.
  const hostArgs = involvement
    ? ['--hostname', projectRef.host]
    : glabHostnameArgs(projectRef, connectionId)

  await acquire()
  try {
    const involvementParam = involvement
      ? await involvementFilterParam(involvement, hostArgs, execOptions)
      : ''
    const { body, headers } = await glabApiWithHeaders(
      [...hostArgs, `${path}${involvementParam}`],
      execOptions
    )
    const data = parseGlabJsonList<Parameters<typeof mapMRToWorkItem>[0]>(body)
    const headerTotalCount = parseGlabPaginationHeader(headers['x-total'], 0)
    // GitLab omits both totals past 10,000 rows and proxies can strip them; a full page advertises one more probe.
    const probedTotalPages = data.length < perPage ? page : page + 1
    return {
      items: data.map((d) => mapMRToWorkItem(d, repoId, projectRef)),
      page,
      perPage,
      totalCount: headerTotalCount ?? 0,
      totalPages:
        parseGlabPaginationHeader(headers['x-total-pages'], 1) ??
        (headerTotalCount === undefined
          ? probedTotalPages
          : Math.max(1, Math.ceil(headerTotalCount / perPage)))
    }
  } catch (err) {
    return {
      items: [],
      page,
      perPage,
      totalCount: 0,
      totalPages: 0,
      error:
        err instanceof GitLabSignInRequiredError
          ? { type: 'permission_denied', message: SIGN_IN_REQUIRED_MESSAGE }
          : classifyListFetchError(err)
    }
  } finally {
    release()
  }
}
