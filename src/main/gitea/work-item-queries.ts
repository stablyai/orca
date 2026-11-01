import type { ClassifiedError } from '../../shared/classified-error'
import type { IssueSourcePreference } from '../../shared/repo-types'
import { requestGiteaJson } from './client'
import { getTeaKnownLogins, type TeaKnownLogin } from './gitea-known-host-probe'
import { resolveGiteaIssueSource } from './gitea-issue-source-resolution'
import { mapGiteaIssueInfoToWorkItem, mapGiteaIssueToWorkItem, type RawGiteaIssue } from './mappers'
import { listGiteaIssues, type GiteaIssueListState } from './issues'
import { listGiteaPullRequests, type PRListState } from './pull-request-list'
import {
  mapGiteaPRToWorkItem,
  type GiteaWorkItem,
  type RawGiteaPullRequest
} from './pull-request-mappers'
import { parseGiteaRepoRef, type GiteaRepoRef, type LocalGitExecOptions } from './repository-ref'

export type GiteaPagedResult<T> = {
  items: T[]
  page: number
  perPage: number
  totalCount: number
  totalPages: number
  error?: ClassifiedError
}

export type GiteaProjectRef = {
  host: string
  path: string
}

function issueIndexPath(repo: GiteaRepoRef, number: number): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/issues/${encodeURIComponent(String(number))}`
}

function pullIndexPath(repo: GiteaRepoRef, number: number): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls/${encodeURIComponent(String(number))}`
}

function emptyPage(
  page: number,
  perPage: number,
  error?: ClassifiedError
): GiteaPagedResult<GiteaWorkItem> {
  return {
    items: [],
    page,
    perPage,
    totalCount: 0,
    totalPages: 0,
    ...(error ? { error } : {})
  }
}

function issueListState(state: PRListState): GiteaIssueListState | null {
  // Issues have no merged state, so that filter is pull requests only.
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

function matchesListState(item: GiteaWorkItem, state: PRListState): boolean {
  if (state === 'all') {
    return true
  }
  if (state === 'merged') {
    return item.state === 'merged'
  }
  if (state === 'opened') {
    return item.state === 'open' || item.state === 'draft'
  }
  return item.state === 'closed' || item.state === 'merged'
}

function loginMatchesHost(login: TeaKnownLogin, host: string): boolean {
  if (login.host.trim().toLowerCase() === host) {
    return true
  }
  try {
    return new URL(login.url).hostname.toLowerCase() === host
  } catch {
    return false
  }
}

export async function repoRefForProject(
  projectRef: GiteaProjectRef,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GiteaRepoRef | null> {
  const host = projectRef.host.trim().toLowerCase()
  const path = projectRef.path.trim().replace(/^\/+|\/+$/g, '')
  if (!host || !path) {
    return null
  }
  const parsed = parseGiteaRepoRef(`https://${host}/${path}`)
  if (!parsed) {
    return null
  }
  const logins = await getTeaKnownLogins(connectionId, localGitOptions)
  const loginName = logins.find((login) => loginMatchesHost(login, parsed.host))?.name.trim()
  return loginName ? { ...parsed, loginName } : parsed
}

async function listExactWorkItem(
  repoPath: string,
  state: PRListState,
  page: number,
  perPage: number,
  number: number,
  preference: IssueSourcePreference | undefined,
  connectionId: string | null | undefined,
  localGitOptions: LocalGitExecOptions
): Promise<GiteaPagedResult<GiteaWorkItem>> {
  const { source } = await resolveGiteaIssueSource(
    repoPath,
    preference,
    connectionId ?? null,
    localGitOptions
  )
  if (!source) {
    return emptyPage(page, perPage, {
      type: 'not_found',
      message: 'No Gitea repository found for this repository.'
    })
  }
  const raw = await requestGiteaJson<RawGiteaIssue>(source, issueIndexPath(source, number), {
    allowNotFound: true
  })
  if (!raw) {
    return emptyPage(page, perPage)
  }
  const repoId = `${source.owner}/${source.repo}`
  let item: GiteaWorkItem | null
  if (raw.pull_request != null) {
    const pull = await requestGiteaJson<RawGiteaPullRequest>(
      source,
      pullIndexPath(source, number),
      {
        allowNotFound: true
      }
    )
    item = pull ? mapGiteaPRToWorkItem(pull, repoId) : null
  } else {
    item = state === 'merged' ? null : mapGiteaIssueToWorkItem(raw, repoId)
  }
  if (!item || !matchesListState(item, state)) {
    return emptyPage(page, perPage)
  }
  return { items: [item], page, perPage, totalCount: 1, totalPages: 1 }
}

export async function listGiteaWorkItems(
  repoPath: string,
  state: PRListState = 'opened',
  page = 1,
  perPage = 20,
  preference?: IssueSourcePreference,
  query?: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GiteaPagedResult<GiteaWorkItem>> {
  const exactNumber = /^#(\d+)$/.exec(query?.trim() ?? '')?.[1]
  if (exactNumber) {
    return listExactWorkItem(
      repoPath,
      state,
      page,
      perPage,
      Number(exactNumber),
      preference,
      connectionId,
      localGitOptions
    )
  }

  const issuesState = issueListState(state)
  const { source } = await resolveGiteaIssueSource(
    repoPath,
    preference,
    connectionId ?? null,
    localGitOptions
  )
  const repoId = source ? `${source.owner}/${source.repo}` : ''
  const [pullRequests, issues] = await Promise.all([
    listGiteaPullRequests(
      repoPath,
      state,
      page,
      perPage,
      preference,
      query,
      connectionId,
      localGitOptions
    ),
    issuesState === null
      ? Promise.resolve<{
          items: GiteaWorkItem[]
          totalCount: number
          totalPages: number
          error: ClassifiedError | undefined
        }>({
          items: [],
          totalCount: 0,
          totalPages: 0,
          error: undefined
        })
      : listGiteaIssues(
          repoPath,
          perPage,
          preference,
          issuesState,
          undefined,
          connectionId,
          localGitOptions,
          page,
          query
        ).then((listed) => ({
          items: listed.items.map((issue) => mapGiteaIssueInfoToWorkItem(issue, repoId)),
          totalCount: listed.totalCount,
          totalPages: listed.totalPages,
          error: listed.error
        }))
  ])
  const items = [...pullRequests.items, ...issues.items].sort((left, right) =>
    (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '')
  )
  const error = pullRequests.error ?? issues.error
  return {
    items,
    page,
    perPage,
    // Each half is paged on its own, so the union total is only a pager bound.
    totalCount: pullRequests.totalCount + issues.totalCount,
    totalPages: Math.max(pullRequests.totalPages, issues.totalPages),
    ...(error ? { error } : {})
  }
}

export async function getGiteaWorkItemByPath(
  repoPath: string,
  projectRef: GiteaProjectRef,
  number: number,
  type: 'issue' | 'pr',
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GiteaWorkItem | null> {
  // repoPath is the caller's workspace cwd; the pasted host/path selects the repository.
  void repoPath
  const repo = await repoRefForProject(projectRef, connectionId, localGitOptions)
  if (!repo) {
    return null
  }
  const repoId = `${repo.owner}/${repo.repo}`
  if (type === 'pr') {
    const raw = await requestGiteaJson<RawGiteaPullRequest>(repo, pullIndexPath(repo, number), {
      allowNotFound: true
    })
    return raw ? mapGiteaPRToWorkItem(raw, repoId) : null
  }
  const raw = await requestGiteaJson<RawGiteaIssue>(repo, issueIndexPath(repo, number), {
    allowNotFound: true
  })
  if (!raw || raw.pull_request != null) {
    return null
  }
  return mapGiteaIssueToWorkItem(raw, repoId)
}
