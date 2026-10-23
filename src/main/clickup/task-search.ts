import {
  CLICKUP_TASK_ID_PATTERN,
  getMatchingClickUpWorkspaces,
  parseClickUpTaskInput
} from '../../shared/clickup-task-url'
import type {
  ClickUpTask,
  ClickUpTaskScope,
  ClickUpWorkspaceSelection
} from '../../shared/clickup-types'
import {
  clickUpRequest,
  getStatus,
  onClickUpDisconnect,
  requireClickUpClients,
  type ClickUpClientForWorkspace
} from './client'
import { getClickUpTaskInWorkspace } from './task-lookup'
import { normalizeClickUpTask } from './task-mapping'
import { clickUpTaskPagePath } from './task-scope'

// Why paging: ClickUp's v2 API has no task-name filter (GET /team/{id}/task only
// filters by assignee, status, List, tag, dates and custom fields; text search
// exists only inside saved Views). So search walks filtered Workspace pages,
// most-likely scopes first, and stops once it has enough matches.
const TASK_PAGE_SIZE = 100
const MAX_SEARCH_RESULTS = 50
// Pages fetched together; matches the client's request pool.
const PAGE_BATCH_SIZE = 3
type SearchScope = 'assigned' | 'open' | 'all'
// Why these caps: the viewer's own tasks are the likeliest hits, every open task
// comes next, and recently closed tasks last. 20 pages (~2,000 tasks) is at most
// a quarter of the token's per-minute budget even from a cold cache, since the
// same token also serves the ClickUp web app and other Orca surfaces.
const SEARCH_SCOPES: readonly { scope: SearchScope; maxPages: number }[] = [
  { scope: 'assigned', maxPages: 3 },
  { scope: 'open', maxPages: 12 },
  { scope: 'all', maxPages: 5 }
]
// Why a page cache: typing refines the query character by character; reusing
// the pages the previous keystroke fetched keeps search off the rate limit.
const PAGE_CACHE_TTL_MS = 2 * 60_000
const MAX_CACHED_PAGES = 80

export class ClickUpSearchSupersededError extends Error {
  constructor() {
    super('A newer ClickUp search replaced this one.')
    this.name = 'ClickUpSearchSupersededError'
  }
}

type TaskPage = { rawCount: number; tasks: ClickUpTask[] }
type CachedPage = { loadedAt: number; page: Promise<TaskPage> }
const pageCache = new Map<string, CachedPage>()
// Each Workspace keeps one live search; a newer query stops the older one paging.
const searchGenerations = new Map<string, number>()

onClickUpDisconnect(() => {
  pageCache.clear()
  searchGenerations.clear()
})

function pagePath(
  workspaceId: string,
  scope: SearchScope,
  page: number,
  viewerId: number | undefined,
  taskScope?: ClickUpTaskScope
): string {
  const query = new URLSearchParams({
    page: String(page),
    // Why no reverse: ClickUp already sorts newest first; reverse=true returned
    // the oldest tasks first, which hid recently updated tasks from search.
    order_by: 'updated',
    subtasks: 'true',
    include_closed: scope === 'all' ? 'true' : 'false'
  })
  if (scope === 'assigned' && viewerId !== undefined) {
    query.set('include_closed', 'true')
    query.append('assignees[]', String(viewerId))
  }
  return clickUpTaskPagePath(workspaceId, query, taskScope)
}

function getSearchPage(
  client: ClickUpClientForWorkspace,
  scope: SearchScope,
  page: number,
  viewerId: number | undefined,
  taskScope?: ClickUpTaskScope
): Promise<TaskPage> {
  const path = pagePath(client.workspace.id, scope, page, viewerId, taskScope)
  const key = `${client.token}\u0000${path}`
  const cached = pageCache.get(key)
  if (cached && Date.now() - cached.loadedAt < PAGE_CACHE_TTL_MS) {
    return cached.page
  }
  const request = clickUpRequest<{ tasks?: unknown[] }>(client, path).then((response) => {
    const rawTasks = response.tasks ?? []
    return {
      rawCount: rawTasks.length,
      tasks: rawTasks
        .map((task) => normalizeClickUpTask(task, client))
        .filter((task): task is ClickUpTask => task !== null)
    }
  })
  pageCache.delete(key)
  pageCache.set(key, { loadedAt: Date.now(), page: request })
  // Why: a failed page must be refetched, not served from cache.
  request.catch(() => pageCache.delete(key))
  while (pageCache.size > MAX_CACHED_PAGES) {
    const oldest = pageCache.keys().next().value
    if (oldest === undefined) {
      break
    }
    pageCache.delete(oldest)
  }
  return request
}

// Lower is better; null means no match. Exact ids beat name prefixes, which
// beat substrings, so "CHP-7616" or a task id surfaces above name hits.
export function rankClickUpTaskMatch(task: ClickUpTask, query: string): number | null {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) {
    return null
  }
  const ids = [task.id, task.customId ?? ''].map((value) => value.toLocaleLowerCase())
  if (ids.includes(needle)) {
    return 0
  }
  const name = task.name.toLocaleLowerCase()
  if (name.startsWith(needle)) {
    return 1
  }
  if (name.includes(needle)) {
    return 2
  }
  if (ids.some((id) => id.length > 0 && id.includes(needle))) {
    return 3
  }
  // Every word must appear, so "honeywell notes" finds "Honeywell Accounts – … Notes".
  const words = needle.split(/\s+/).filter(Boolean)
  return words.length > 1 && words.every((word) => name.includes(word)) ? 4 : null
}

type RankedTask = { task: ClickUpTask; rank: number }

function looksLikeNativeTaskId(query: string): boolean {
  return CLICKUP_TASK_ID_PATTERN.test(query) && /\d/.test(query) && /[a-z]/.test(query)
}

async function lookupExactTask(
  clients: ClickUpClientForWorkspace[],
  query: string
): Promise<RankedTask[]> {
  const trimmed = query.trim()
  const parsed =
    parseClickUpTaskInput(trimmed) ??
    (looksLikeNativeTaskId(trimmed)
      ? { taskId: trimmed, isCustomId: false, workspaceId: null, origin: '' }
      : null)
  if (!parsed) {
    return []
  }
  const allowed = new Set(
    getMatchingClickUpWorkspaces(
      parsed,
      clients.map((client) => client.workspace)
    ).map((workspace) => workspace.id)
  )
  // Native ids are global to the token, so one lookup is enough.
  const targets = clients.filter((client) => allowed.has(client.workspace.id))
  const lookups = parsed.isCustomId ? targets : targets.slice(0, 1)
  const found = await Promise.all(
    lookups.map((client) =>
      getClickUpTaskInWorkspace(client, parsed.taskId, { tolerateMisses: true })
    )
  )
  return found.flatMap((task) => (task ? [{ task, rank: 0 }] : []))
}

async function scanWorkspace(
  client: ClickUpClientForWorkspace,
  query: string,
  limit: number,
  viewerId: number | undefined,
  taskScope?: ClickUpTaskScope
): Promise<RankedTask[]> {
  const workspaceKey = `${client.token}\u0000${client.workspace.id}`
  const generation = (searchGenerations.get(workspaceKey) ?? 0) + 1
  searchGenerations.set(workspaceKey, generation)
  const matches = new Map<string, RankedTask>()
  for (const { scope, maxPages } of SEARCH_SCOPES) {
    if (scope === 'assigned' && viewerId === undefined) {
      continue
    }
    let first = 0
    while (first < maxPages && matches.size < limit) {
      // Why: a newer query for this Workspace supersedes this one; stop paging
      // so stale keystrokes do not spend the rate-limit budget.
      // Throwing (not returning partial matches) keeps the renderer from caching
      // an incomplete result under the old query.
      if (searchGenerations.get(workspaceKey) !== generation) {
        throw new ClickUpSearchSupersededError()
      }
      // Why page 0 alone: most scopes (the viewer's tasks, small Workspaces)
      // fit in one page, so only fan out once a scope proves to be large.
      const batchSize = first === 0 ? 1 : Math.min(PAGE_BATCH_SIZE, maxPages - first)
      const pageNumbers = Array.from({ length: batchSize }, (_, index) => first + index)
      first += batchSize
      const pages = await Promise.all(
        pageNumbers.map((page) => getSearchPage(client, scope, page, viewerId, taskScope))
      )
      for (const page of pages) {
        for (const task of page.tasks) {
          const rank = rankClickUpTaskMatch(task, query)
          if (rank !== null && !matches.has(task.id)) {
            matches.set(task.id, { task, rank })
          }
        }
      }
      if (pages.some((page) => page.rawCount < TASK_PAGE_SIZE)) {
        break
      }
    }
    if (matches.size >= limit) {
      break
    }
  }
  return [...matches.values()]
}

export async function searchClickUpTasks(
  query: string,
  limit = 20,
  workspaceId?: ClickUpWorkspaceSelection | null,
  taskScope?: ClickUpTaskScope
): Promise<ClickUpTask[]> {
  const trimmed = query.trim()
  if (!trimmed) {
    return []
  }
  const safeLimit = Math.min(Math.max(1, limit), MAX_SEARCH_RESULTS)
  const clients = requireClickUpClients(workspaceId)
  const exact = await lookupExactTask(clients, trimmed)
  // Why: an id, custom id, or task URL names one task; paging the Workspace
  // for it would only spend requests.
  if (exact.length > 0) {
    return exact.map((match) => match.task).slice(0, safeLimit)
  }
  const viewerId = getStatus().viewer?.id
  const scanned = await Promise.all(
    clients.map((client) => scanWorkspace(client, trimmed, safeLimit, viewerId, taskScope))
  )
  return scanned
    .flat()
    .sort((a, b) => a.rank - b.rank || b.task.updatedAt.localeCompare(a.task.updatedAt))
    .slice(0, safeLimit)
    .map((match) => match.task)
}

export function clearClickUpSearchCacheForTests(): void {
  pageCache.clear()
  searchGenerations.clear()
}
