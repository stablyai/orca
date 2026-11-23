import {
  parseClickUpTaskReference,
  type ClickUpTaskReference
} from '../../shared/clickup/clickup-task-reference'
import type {
  ClickUpComment,
  ClickUpStatusOption,
  ClickUpTask,
  ClickUpTaskListFilter,
  ClickUpTaskPage
} from '../../shared/clickup/clickup-types'
import { clickupRequest } from './authenticated-request'
import { isClickUpTaskUnavailableError } from './clickup-api-error'
import { withClickUpContext, type ClickUpContext, type ClickUpOperationContext } from './client'
import {
  mapClickUpComments,
  mapClickUpListStatuses,
  mapClickUpTask,
  mapClickUpTaskPage
} from './clickup-response-mapping'
import { clickUpTaskMatchesText, parseClickUpSearchIntent } from './clickup-task-search-query'
import {
  clickUpScanPageKey,
  readScannedClickUpPage,
  scannedClickUpPagesEpoch,
  writeScannedClickUpPage
} from './clickup-task-scan-cache'

const SEARCH_PAGE_LIMIT = 5
const COMMENT_PAGE_SIZE = 25
const COMMENT_PAGE_LIMIT = 4

const EMPTY_PAGE: ClickUpTaskPage = { tasks: [], nextPage: null }

/** Path and query that address one task, adding the Workspace scope a custom id needs. */
export function taskEndpoint(
  reference: ClickUpTaskReference,
  context: Pick<ClickUpContext, 'workspaceId'>,
  suffix = '',
  query: URLSearchParams = new URLSearchParams()
): string | null {
  if (reference.kind === 'custom-id') {
    const workspaceId = reference.workspaceId ?? context.workspaceId
    if (!workspaceId) {
      return null
    }
    query.set('custom_task_ids', 'true')
    query.set('team_id', workspaceId)
  }
  const id = reference.kind === 'id' ? reference.id : reference.customId
  const queryString = query.toString()
  return `/task/${encodeURIComponent(id)}${suffix}${queryString ? `?${queryString}` : ''}`
}

function listQuery(filter: ClickUpTaskListFilter, viewerId: string | null, page: number) {
  const query = new URLSearchParams({
    page: String(page),
    order_by: 'updated',
    reverse: 'false',
    subtasks: 'true',
    include_closed: String(filter.includeClosed),
    include_markdown_description: 'true'
  })
  if (filter.scope === 'assigned' && viewerId) {
    query.append('assignees[]', viewerId)
  }
  for (const status of filter.statuses ?? []) {
    query.append('statuses[]', status)
  }
  return query
}

function scanKeyFor(
  context: ClickUpOperationContext,
  workspaceId: string,
  filter: ClickUpTaskListFilter,
  page: number
): string {
  return clickUpScanPageKey({ workspaceId, viewerId: context.viewer?.id ?? null }, filter, page)
}

// Every fetched page refreshes the scan cache, so a plain list reload or a forced search also freshens later searches.
async function fetchTaskPage(
  context: ClickUpOperationContext,
  filter: ClickUpTaskListFilter,
  page: number
): Promise<ClickUpTaskPage> {
  if (!context.workspaceId) {
    return EMPTY_PAGE
  }
  const epoch = scannedClickUpPagesEpoch()
  const payload = await clickupRequest<unknown>(
    context.token,
    `/team/${encodeURIComponent(context.workspaceId)}/task?${listQuery(filter, context.viewer?.id ?? null, page)}`,
    { signal: context.signal }
  )
  const result = mapClickUpTaskPage(payload, context.workspaceId, page, filter.includeClosed)
  writeScannedClickUpPage(scanKeyFor(context, context.workspaceId, filter, page), result, epoch)
  return result
}

export async function listTasks(
  filter: ClickUpTaskListFilter,
  page: number
): Promise<ClickUpTaskPage> {
  return (await withClickUpContext((context) => fetchTaskPage(context, filter, page))) ?? EMPTY_PAGE
}

async function fetchTask(
  context: ClickUpOperationContext,
  reference: ClickUpTaskReference
): Promise<ClickUpTask | null> {
  const endpoint = taskEndpoint(
    reference,
    context,
    '',
    new URLSearchParams({ include_markdown_description: 'true' })
  )
  if (!endpoint) {
    return null
  }
  try {
    return mapClickUpTask(
      await clickupRequest<unknown>(context.token, endpoint, { signal: context.signal }),
      context.workspaceId ?? ''
    )
  } catch (error) {
    if (isClickUpTaskUnavailableError(error)) {
      return null
    }
    throw error
  }
}

/** Resolves a task id, custom id or task URL; null when it is malformed, missing or not visible. */
export async function getTask(input: string): Promise<ClickUpTask | null> {
  const reference = parseClickUpTaskReference(input)
  if (!reference) {
    return null
  }
  return (await withClickUpContext((context) => fetchTask(context, reference))) ?? null
}

// A page seen moments ago is reused, so a query refined keystroke by keystroke filters locally instead of rescanning.
async function scanTaskPage(
  context: ClickUpOperationContext,
  workspaceId: string,
  filter: ClickUpTaskListFilter,
  page: number,
  fresh: boolean
): Promise<ClickUpTaskPage> {
  const cached = fresh
    ? null
    : readScannedClickUpPage(scanKeyFor(context, workspaceId, filter, page))
  return cached ?? fetchTaskPage(context, filter, page)
}

// ClickUp has no text search, so matching covers the most recently updated tasks only.
async function searchByText(
  context: ClickUpOperationContext,
  text: string,
  filter: ClickUpTaskListFilter,
  fresh: boolean
): Promise<ClickUpTask[]> {
  if (!context.workspaceId) {
    return []
  }
  const matches: ClickUpTask[] = []
  let page: number | null = 0
  for (let fetched = 0; page !== null && fetched < SEARCH_PAGE_LIMIT; fetched++) {
    const result: ClickUpTaskPage = await scanTaskPage(
      context,
      context.workspaceId,
      filter,
      page,
      fresh
    )
    matches.push(...result.tasks.filter((task) => clickUpTaskMatchesText(task, text)))
    page = result.nextPage
  }
  return matches
}

/**
 * `signal` cancels a superseded search, which otherwise keeps scanning pages for a query nobody reads.
 * `fresh` skips the scanned-page cache for a forced refresh; the pages it fetches still repopulate it.
 */
export async function searchTasks(
  query: string,
  filter: ClickUpTaskListFilter,
  signal?: AbortSignal,
  fresh = false
): Promise<ClickUpTask[]> {
  const intent = parseClickUpSearchIntent(query)
  const tasks = await withClickUpContext(async (context) => {
    if (intent.kind === 'reference') {
      const task = await fetchTask(context, intent.reference)
      if (task) {
        return [task]
      }
      // A pasted URL names exactly one task; a bare token may just be a word.
      if (intent.fromUrl) {
        return []
      }
    }
    return searchByText(context, query.trim(), filter, fresh)
  }, signal)
  return tasks ?? []
}

async function fetchCommentPages(
  context: ClickUpOperationContext,
  reference: ClickUpTaskReference
): Promise<ClickUpComment[]> {
  const comments = new Map<string, ClickUpComment>()
  let cursor: { start: string; startId: string } | null = null
  for (let fetched = 0; fetched < COMMENT_PAGE_LIMIT; fetched++) {
    const query = new URLSearchParams()
    if (cursor) {
      query.set('start', cursor.start)
      query.set('start_id', cursor.startId)
    }
    const endpoint = taskEndpoint(reference, context, '/comment', query)
    if (!endpoint) {
      break
    }
    const payload = await clickupRequest<unknown>(context.token, endpoint, {
      signal: context.signal
    })
    const page = mapClickUpComments(payload)
    const before = comments.size
    for (const comment of page) {
      comments.set(comment.id, comment)
    }
    // Pages arrive newest first; the oldest entry seeds the request for older comments.
    const oldest = page.reduce<ClickUpComment | null>(
      (min, comment) => (!min || comment.createdAt < min.createdAt ? comment : min),
      null
    )
    if (page.length < COMMENT_PAGE_SIZE || comments.size === before || !oldest) {
      break
    }
    cursor = { start: String(Date.parse(oldest.createdAt)), startId: oldest.id }
  }
  return [...comments.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export async function getTaskComments(input: string): Promise<ClickUpComment[]> {
  const reference = parseClickUpTaskReference(input)
  if (!reference) {
    return []
  }
  return (await withClickUpContext((context) => fetchCommentPages(context, reference))) ?? []
}

/** Statuses a task in this List can use; a status belongs to a List, not to a Workspace. */
export async function listStatuses(listId: string): Promise<ClickUpStatusOption[]> {
  const statuses = await withClickUpContext(async (context) =>
    mapClickUpListStatuses(
      await clickupRequest<unknown>(context.token, `/list/${encodeURIComponent(listId)}`, {
        signal: context.signal
      })
    )
  )
  return statuses ?? []
}
