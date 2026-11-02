import type { ClassifiedError } from '../../shared/classified-error'
import type { IssueSourcePreference } from '../../shared/repo-types'
import { getAuthenticatedViewer } from './gitea-auth-and-rate-limit'
import { requestGiteaJson, requestGiteaJsonWithHeaders } from './client'
import { getGiteaIssueRepoRef, resolveGiteaIssueSource } from './gitea-issue-source-resolution'
import { mapGiteaIssueInfo, type GiteaIssueInfo, type RawGiteaIssue } from './mappers'
import type { LocalGitExecOptions } from './repository-ref'
import { parseTeaPaginationTotal } from './tea-api-response'

export { addGiteaIssueComment, createGiteaIssue } from './issue-create'

export type GiteaIssueListState = 'opened' | 'closed' | 'all'

export type GiteaIssueListResult = {
  items: GiteaIssueInfo[]
  page: number
  perPage: number
  totalCount: number
  totalPages: number
  error?: ClassifiedError
}

export async function getGiteaIssue(
  repoPath: string,
  issueNumber: number,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GiteaIssueInfo | null> {
  const repo = await getGiteaIssueRepoRef(repoPath, connectionId, localGitOptions)
  if (!repo) {
    return null
  }
  const raw = await requestGiteaJson<RawGiteaIssue>(
    repo,
    `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/issues/${encodeURIComponent(String(issueNumber))}`,
    { allowNotFound: true }
  )
  if (!raw || raw.pull_request != null) {
    return null
  }
  return mapGiteaIssueInfo(raw)
}

function giteaIssueState(state: GiteaIssueListState): 'open' | 'closed' | 'all' {
  if (state === 'opened') {
    return 'open'
  }
  if (state === 'all') {
    return 'all'
  }
  return 'closed'
}

function totalPagesFor(totalCount: number, perPage: number): number {
  if (perPage <= 0 || totalCount <= 0) {
    return 0
  }
  return Math.ceil(totalCount / perPage)
}

function issueListPath(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`
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

export async function listGiteaIssues(
  repoPath: string,
  limit = 20,
  preference?: IssueSourcePreference,
  state: GiteaIssueListState = 'opened',
  assignee?: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {},
  page = 1,
  query?: string
): Promise<GiteaIssueListResult> {
  const currentPage = Number.isFinite(page) ? Math.max(1, Math.trunc(page)) : 1
  const perPage = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : 20
  const { source } = await resolveGiteaIssueSource(
    repoPath,
    preference,
    connectionId ?? null,
    localGitOptions
  )
  if (!source) {
    return {
      items: [],
      page: currentPage,
      perPage,
      totalCount: 0,
      totalPages: 0,
      error: {
        type: 'not_found',
        message: 'No Gitea repository found for this repository.'
      }
    }
  }

  let assignedBy: string | undefined
  const assigneeName = assignee?.trim()
  if (assigneeName === '@me') {
    const viewer = await getAuthenticatedViewer(source.loginName ?? source.host)
    const username = viewer?.username.trim()
    if (!username) {
      return {
        items: [],
        page: currentPage,
        perPage,
        totalCount: 0,
        totalPages: 0,
        error: {
          type: 'permission_denied',
          message: 'Could not resolve the authenticated Gitea user.'
        }
      }
    }
    assignedBy = username
  } else if (assigneeName) {
    assignedBy = assigneeName
  }

  const keyword = query?.trim()
  try {
    const { data, headers } = await requestGiteaJsonWithHeaders<RawGiteaIssue[]>(
      source,
      issueListPath(source.owner, source.repo),
      {
        searchParams: {
          type: 'issues',
          state: giteaIssueState(state),
          page: currentPage,
          limit: perPage,
          ...(assignedBy ? { assigned_by: assignedBy } : {}),
          ...(keyword ? { q: keyword } : {})
        }
      }
    )
    const items = (Array.isArray(data) ? data : []).flatMap((raw) => {
      if (raw.pull_request != null) {
        return []
      }
      const item = mapGiteaIssueInfo(raw)
      return item ? [item] : []
    })
    const totalCount = parseTeaPaginationTotal(headers) ?? items.length
    return {
      items,
      page: currentPage,
      perPage,
      totalCount,
      totalPages: totalPagesFor(totalCount, perPage)
    }
  } catch (error) {
    return {
      items: [],
      page: currentPage,
      perPage,
      totalCount: 0,
      totalPages: 0,
      error: classifyListError(error)
    }
  }
}
