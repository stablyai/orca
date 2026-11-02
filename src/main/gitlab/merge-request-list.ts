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
import { isTaskRepositoryIneligible } from '../git/task-repository-eligibility'

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
  involvement?: GitLabMRInvolvement
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
    if (connectionId || involvement) {
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

  await acquire()
  try {
    if (involvement === 'mine' || involvement === 'needs-review') {
      const options = glabRepoExecOptions(repoPath, connectionId, localGitOptions)
      const hostArgs = ['--hostname', projectRef.host]
      const { stdout } = await glabExecFileAsync(['api', ...hostArgs, 'user'], options)
      const viewer = JSON.parse(stdout)
      if (!Number.isSafeInteger(viewer.id) || viewer.id <= 0) {
        throw new Error('Could not identify the authenticated GitLab user.')
      }
      const filters =
        involvement === 'mine'
          ? [`author_id=${viewer.id}`, `assignee_id=${viewer.id}&not[author_id]=${viewer.id}`]
          : [`reviewer_id=${viewer.id}`]
      // Read each disjoint stream's prefix before slicing the combined, updated-at ordered page.
      const streams: {
        items: ReturnType<typeof mapMRToWorkItem>[]
        totalCount: number | undefined
        totalPages: number | undefined
        hasMore: boolean
      }[] = []
      for (const filter of filters) {
        const items: ReturnType<typeof mapMRToWorkItem>[] = []
        let totalCount: number | undefined
        let totalPages: number | undefined
        let hasMore = true
        const firstPage = involvement === 'mine' ? 1 : page
        const prefixSize = involvement === 'mine' ? page * perPage : perPage
        for (let streamPage = firstPage; hasMore && items.length < prefixSize; streamPage++) {
          const streamPath = path.replace(`page=${page}&`, `page=${streamPage}&`)
          const response = await glabApiWithHeaders(
            [...hostArgs, `${streamPath}&scope=all&${filter}`],
            options
          )
          const data = parseGlabJsonList<Parameters<typeof mapMRToWorkItem>[0]>(response.body)
          items.push(...data.map((d) => mapMRToWorkItem(d, repoId, projectRef)))
          totalCount = parseGlabPaginationHeader(response.headers['x-total'], 0)
          totalPages = parseGlabPaginationHeader(response.headers['x-total-pages'], 1)
          hasMore = totalPages === undefined ? data.length === perPage : streamPage < totalPages
        }
        streams.push({ items, totalCount, totalPages, hasMore })
      }
      const combined = streams
        .flatMap((stream) => stream.items)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.number - a.number)
      const items = [...new Map(combined.map((item) => [item.number, item])).values()]
      const totalKnown = streams.every((stream) => stream.totalCount !== undefined)
      const totalCount = totalKnown
        ? streams.reduce((sum, stream) => sum + (stream.totalCount ?? 0), 0)
        : 0
      const hasMore = streams.some((stream) => stream.hasMore) || items.length > page * perPage
      return {
        items: involvement === 'mine' ? items.slice((page - 1) * perPage, page * perPage) : items,
        page,
        perPage,
        totalCount,
        totalPages:
          involvement === 'needs-review' && streams[0]?.totalPages !== undefined
            ? streams[0].totalPages
            : totalKnown
              ? Math.max(1, Math.ceil(totalCount / perPage))
              : hasMore
                ? page + 1
                : page
      }
    }
    const { body, headers } = await glabApiWithHeaders(
      [...glabHostnameArgs(projectRef, connectionId), path],
      glabRepoExecOptions(repoPath, connectionId, localGitOptions)
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
      error: classifyListFetchError(err)
    }
  } finally {
    release()
  }
}
