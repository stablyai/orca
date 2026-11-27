import {
  ITSAPLAN_LIST_LIMIT_MAX,
  type ItsaplanComment,
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
const MAX_FEED_PAGES = 10

type RawIssueHit = ItsaplanRawIssue & { archived?: boolean }
type RawIssueDetail = ItsaplanRawIssue & { projectId: number }

export async function requireItsaplanAppUrl(): Promise<string> {
  const instance = await readItsaplanInstance()
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
  const appUrl = await requireItsaplanAppUrl()
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

  // The list route filters by a single column, so each state column is read on its own.
  const fetchLimit = search || filters.assignee === 'unassigned' ? ITSAPLAN_LIST_LIMIT_MAX : limit
  const listColumn = (columnId: number | undefined) =>
    itsaplanRequest<RawIssueHit[]>(`${projectPath(query.projectRef)}/issues`, {
      query: {
        columnId,
        assigneeUserId,
        labelIds: filters.labelIds?.length ? filters.labelIds : undefined,
        limit: fetchLimit
      }
    })

  const hits = search
    ? await itsaplanRequest<RawIssueHit[]>(`${projectPath(query.projectRef)}/issues/search`, {
        query: { q: search, limit: fetchLimit }
      })
    : columnIds && columnIds.length > 1
      ? (await Promise.all(columnIds.map((id) => listColumn(id))))
          .flat()
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id)
      : await listColumn(columnIds?.[0])

  return hits
    .filter((hit) => !hit.archived)
    .filter((hit) => !columnIds || columnIds.includes(hit.columnId))
    .filter((hit) => !search || !assigneeUserId || hit.assigneeUserId === assigneeUserId)
    .filter((hit) => filters.assignee !== 'unassigned' || hit.assigneeUserId === null)
    .filter((hit) => !filters.labelIds || filters.labelIds.every((id) => hit.labelIds.includes(id)))
    .slice(0, limit)
    .map((hit) => mapItsaplanIssue(hit, { metadata, appUrl }))
}

type RawFeedPage = {
  items: ItsaplanRawFeedItem[]
  nextCursor: { ts: string; id: number } | null
}

// The feed pages top-level entries and appends their replies, so order is rebuilt here.
async function readAllComments(issueId: number): Promise<ItsaplanComment[]> {
  const comments: ItsaplanComment[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_FEED_PAGES; page += 1) {
    const feed = await itsaplanRequest<RawFeedPage>(`/issues/${issueId}/feed`, {
      query: { filter: 'comments', order: 'asc', limit: 100, cursor }
    })
    comments.push(...feed.items.flatMap((item) => mapItsaplanComment(item) ?? []))
    if (!feed.nextCursor) {
      break
    }
    cursor = JSON.stringify(feed.nextCursor)
  }
  return comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id)
}

export async function itsaplanGetIssue(args: {
  issueId: number
  projectRef?: string
}): Promise<ItsaplanIssueDetail | null> {
  const appUrl = await requireItsaplanAppUrl()
  let raw: RawIssueDetail
  try {
    raw = await itsaplanRequest<RawIssueDetail>(`/issues/${args.issueId}`)
  } catch (error) {
    if (error instanceof ItsaplanApiError && error.code === 'notFound') {
      return null
    }
    throw error
  }
  const projectRef = await resolveItsaplanProjectRef(raw.projectId, args.projectRef)
  const metadata = await itsaplanGetProjectMetadata({ projectRef })
  const [subtaskHits, comments] = await Promise.all([
    itsaplanRequest<RawIssueHit[]>(`${projectPath(projectRef)}/issues`, {
      query: { parentId: raw.id, limit: ITSAPLAN_LIST_LIMIT_MAX }
    }),
    readAllComments(raw.id)
  ])
  return {
    ...mapItsaplanIssue(raw, { metadata, appUrl }),
    subtasks: subtaskHits.map((hit) => mapItsaplanIssue(hit, { metadata, appUrl })),
    comments
  }
}
