import {
  ITSAPLAN_LIST_LIMIT_MAX,
  type ItsaplanIssue,
  type ItsaplanIssueDetail,
  type ItsaplanIssueListQuery,
  type ItsaplanProjectMetadata
} from '../../shared/itsaplan/itsaplan-types'
import { ItsaplanApiError, itsaplanRequest } from './client'
import { itsaplanRequireViewerId } from './itsaplan-connection'
import {
  mapItsaplanComment,
  mapItsaplanIssue,
  type ItsaplanRawFeedItem,
  type ItsaplanRawIssue
} from './itsaplan-issue-mapping'
import { itsaplanGetProjectMetadata, resolveItsaplanProjectRef } from './itsaplan-project-queries'
import { readItsaplanInstance } from './instance-credential-store'

const DEFAULT_LIST_LIMIT = 100

type RawIssueHit = ItsaplanRawIssue & { archived?: boolean }
type RawIssueDetail = ItsaplanRawIssue & { projectId: number }

export function requireItsaplanAppUrl(): string {
  const instance = readItsaplanInstance()
  if (!instance) {
    throw new ItsaplanApiError('notConnected')
  }
  return instance.appUrl
}

function projectPath(projectRef: string): string {
  return `/projects/${encodeURIComponent(projectRef)}`
}

function stateColumnIds(metadata: ItsaplanProjectMetadata, query: ItsaplanIssueListQuery) {
  const { stateTypes } = query.filters
  if (!stateTypes?.length) {
    return null
  }
  return metadata.columns.filter((c) => stateTypes.includes(c.stateType)).map((c) => c.id)
}

export async function itsaplanListIssues(query: ItsaplanIssueListQuery): Promise<ItsaplanIssue[]> {
  const appUrl = requireItsaplanAppUrl()
  const metadata = await itsaplanGetProjectMetadata({ projectRef: query.projectRef })
  const { filters } = query
  const limit = Math.min(query.limit ?? DEFAULT_LIST_LIMIT, ITSAPLAN_LIST_LIMIT_MAX)
  const columnIds = stateColumnIds(metadata, query)
  if (columnIds?.length === 0) {
    return []
  }
  const assigneeUserId =
    filters.assignee === 'me'
      ? await itsaplanRequireViewerId()
      : typeof filters.assignee === 'object'
        ? filters.assignee.userId
        : undefined
  const search = query.search?.trim()

  // The list route filters by a single column; the search route only by text.
  const serverColumnId = !search && columnIds?.length === 1 ? columnIds[0] : undefined
  const clientFiltersState = columnIds !== null && serverColumnId === undefined
  const clientFiltersOthers = Boolean(search) || filters.assignee === 'unassigned'
  const fetchLimit = clientFiltersState || clientFiltersOthers ? ITSAPLAN_LIST_LIMIT_MAX : limit

  const hits = search
    ? await itsaplanRequest<RawIssueHit[]>(`${projectPath(query.projectRef)}/issues/search`, {
        query: { q: search, limit: fetchLimit }
      })
    : await itsaplanRequest<RawIssueHit[]>(`${projectPath(query.projectRef)}/issues`, {
        query: {
          columnId: serverColumnId,
          assigneeUserId,
          labelIds: filters.labelIds?.length ? filters.labelIds : undefined,
          limit: fetchLimit
        }
      })

  return hits
    .filter((hit) => !hit.archived)
    .filter((hit) => !columnIds || columnIds.includes(hit.columnId))
    .filter((hit) => !search || !assigneeUserId || hit.assigneeUserId === assigneeUserId)
    .filter((hit) => filters.assignee !== 'unassigned' || hit.assigneeUserId === null)
    .filter((hit) => !filters.labelIds || filters.labelIds.every((id) => hit.labelIds.includes(id)))
    .slice(0, limit)
    .map((hit) => mapItsaplanIssue(hit, { metadata, appUrl }))
}

export async function itsaplanGetIssue(args: {
  issueId: number
}): Promise<ItsaplanIssueDetail | null> {
  const appUrl = requireItsaplanAppUrl()
  let raw: RawIssueDetail
  try {
    raw = await itsaplanRequest<RawIssueDetail>(`/issues/${args.issueId}`)
  } catch (error) {
    if (error instanceof ItsaplanApiError && error.code === 'notFound') {
      return null
    }
    throw error
  }
  const projectRef = await resolveItsaplanProjectRef(raw.projectId)
  const metadata = await itsaplanGetProjectMetadata({ projectRef })
  const [subtaskHits, feed] = await Promise.all([
    itsaplanRequest<RawIssueHit[]>(`${projectPath(projectRef)}/issues`, {
      query: { parentId: raw.id, limit: ITSAPLAN_LIST_LIMIT_MAX }
    }),
    itsaplanRequest<{ items: ItsaplanRawFeedItem[] }>(`/issues/${raw.id}/feed`, {
      query: { filter: 'comments', order: 'asc', limit: 100 }
    })
  ])
  return {
    ...mapItsaplanIssue(raw, { metadata, appUrl }),
    subtasks: subtaskHits.map((hit) => mapItsaplanIssue(hit, { metadata, appUrl })),
    comments: feed.items.flatMap((item) => mapItsaplanComment(item) ?? [])
  }
}
