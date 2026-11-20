import type { ClassifiedError } from '../../shared/errors/classified-error'
import type { IssueSourcePreference } from '../../shared/repository/repo-types'
import { requestGiteaJsonWithHeaders } from './gitea-json-request'
import { resolveGiteaIssueSource } from './gitea-issue-source-resolution'
import { mapGiteaPRToWorkItem, type RawGiteaPullRequest } from './pull-request-mappers'
import type { LocalGitExecOptions } from './repository-ref'
import { parseGtPaginationTotal } from './gt-api-response'
import type { ListGiteaPullRequestsResult, PRListState } from '../../shared/gitea-types'

export type { ListGiteaPullRequestsResult, PRListState }

function giteaListState(state: PRListState): 'open' | 'closed' | 'all' {
  if (state === 'opened') {
    return 'open'
  }
  if (state === 'all') {
    return 'all'
  }
  return 'closed'
}

function isMergedPullRequest(raw: RawGiteaPullRequest): boolean {
  return raw.merged === true || raw.has_merged === true
}

function totalPagesFor(totalCount: number, perPage: number): number {
  if (perPage <= 0 || totalCount <= 0) {
    return 0
  }
  return Math.ceil(totalCount / perPage)
}

function emptyResult(
  page: number,
  perPage: number,
  error: ClassifiedError
): ListGiteaPullRequestsResult {
  return { items: [], page, perPage, totalCount: 0, totalPages: 0, error }
}

function classifyListError(error: unknown): ClassifiedError {
  const message = error instanceof Error ? error.message : String(error)
  const status = /HTTP (\d{3})/.exec(message)?.[1]
  if (status === '401' || status === '403') {
    return { type: 'permission_denied', message }
  }
  if (status === '404') {
    return { type: 'not_found', message }
  }
  if (status === '429') {
    return { type: 'rate_limited', message }
  }
  if (/timeout|network|fetch failed|ECONN/i.test(message)) {
    return { type: 'network_error', message }
  }
  return { type: 'unknown', message }
}

export async function listGiteaPullRequests(
  repoPath: string,
  state: PRListState = 'opened',
  page = 1,
  perPage = 20,
  preference?: IssueSourcePreference,
  query?: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<ListGiteaPullRequestsResult> {
  const { source } = await resolveGiteaIssueSource(
    repoPath,
    preference,
    connectionId ?? null,
    localGitOptions
  )
  if (!source) {
    return emptyResult(page, perPage, {
      type: 'not_found',
      message: 'No Gitea repository found for this repository.'
    })
  }

  const keyword = query?.trim()
  const repoId = `${source.owner}/${source.repo}`
  try {
    const { data, headers } = await requestGiteaJsonWithHeaders<RawGiteaPullRequest[]>(
      source,
      `/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/pulls`,
      {
        searchParams: {
          state: giteaListState(state),
          page,
          limit: perPage,
          ...(keyword ? { q: keyword } : {})
        }
      }
    )
    const rows = (Array.isArray(data) ? data : []).filter(
      (raw) => state !== 'merged' || isMergedPullRequest(raw)
    )
    const items = rows.flatMap((raw) => {
      const item = mapGiteaPRToWorkItem(raw, repoId)
      return item ? [item] : []
    })
    const totalCount = parseGtPaginationTotal(headers) ?? items.length
    return {
      items,
      page,
      perPage,
      totalCount,
      totalPages: totalPagesFor(totalCount, perPage)
    }
  } catch (error) {
    return emptyResult(page, perPage, classifyListError(error))
  }
}
