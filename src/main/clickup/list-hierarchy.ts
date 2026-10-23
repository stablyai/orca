import type {
  ClickUpList,
  ClickUpSpace,
  ClickUpWorkspaceSelection
} from '../../shared/clickup-types'
import {
  clickUpRequest,
  onClickUpDisconnect,
  requireClickUpClients,
  type ClickUpClientForWorkspace
} from './client'
import {
  asRecord,
  asString,
  normalizeClickUpLocation,
  normalizeClickUpStatus,
  timestampToIso
} from './task-mapping'

// Why caches: Spaces, Folders and Lists rarely change while walking them costs
// requests against the token's per-minute budget. Every reader (create dialog,
// Space/Sprint/Status filters, detail sheet) shares these entries.
const HIERARCHY_TTL_MS = 5 * 60_000

type CacheEntry<T> = { loadedAt: number; value: Promise<T> }
const spaceCache = new Map<string, CacheEntry<ClickUpSpace[]>>()
const spaceListCache = new Map<string, CacheEntry<ClickUpList[]>>()
const listDetailCache = new Map<string, CacheEntry<ClickUpList[]>>()

export function clearClickUpListCache(): void {
  spaceCache.clear()
  spaceListCache.clear()
  listDetailCache.clear()
}

onClickUpDisconnect(clearClickUpListCache)

// Shares one in-flight or fresh load per key and drops failures so the next
// caller retries instead of reading a cached error.
function cached<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  load: () => Promise<T>
): Promise<T> {
  const entry = cache.get(key)
  if (entry && Date.now() - entry.loadedAt < HIERARCHY_TTL_MS) {
    return entry.value
  }
  const value = load()
  cache.set(key, { loadedAt: Date.now(), value })
  value.catch(() => {
    if (cache.get(key)?.value === value) {
      cache.delete(key)
    }
  })
  return value
}

function cacheKey(client: ClickUpClientForWorkspace, id: string): string {
  // Why the token: reconnecting with another account must not reuse data the
  // previous token could see.
  return `${client.token}\u0000${client.workspace.id}\u0000${id}`
}

function normalizeList(
  value: unknown,
  client: ClickUpClientForWorkspace,
  fallbackSpace?: { id: string; name: string },
  fallbackFolder?: { id: string; name: string }
): ClickUpList | null {
  const record = asRecord(value)
  const id = asString(record?.id)
  const name = asString(record?.name)
  if (!record || !id || !name || record.archived === true) {
    return null
  }
  return {
    id,
    workspaceId: client.workspace.id,
    workspaceName: client.workspace.name,
    name,
    url: asString(record.url),
    space: normalizeClickUpLocation(record.space) ?? fallbackSpace,
    folder: normalizeClickUpLocation(record.folder) ?? fallbackFolder,
    statuses: Array.isArray(record.statuses) ? record.statuses.map(normalizeClickUpStatus) : [],
    startDate: timestampToIso(record.start_date) ?? null,
    dueDate: timestampToIso(record.due_date) ?? null,
    taskCount: taskCount(record.task_count)
  }
}

// ClickUp sends task_count as a number or a numeric string depending on the endpoint.
function taskCount(value: unknown): number | null {
  const count = typeof value === 'string' ? Number(value) : value
  return typeof count === 'number' && Number.isFinite(count) && count >= 0 ? count : null
}

function normalizeLists(
  values: unknown,
  client: ClickUpClientForWorkspace,
  space: { id: string; name: string },
  folder?: { id: string; name: string }
): ClickUpList[] {
  return (Array.isArray(values) ? values : []).flatMap((value) => {
    const list = normalizeList(value, client, space, folder)
    return list ? [list] : []
  })
}

function spacesForWorkspace(client: ClickUpClientForWorkspace): Promise<ClickUpSpace[]> {
  return cached(spaceCache, cacheKey(client, 'spaces'), async () => {
    const response = await clickUpRequest<{ spaces?: unknown[] }>(
      client,
      `/team/${encodeURIComponent(client.workspace.id)}/space?archived=false`
    )
    return (response.spaces ?? []).flatMap((value) => {
      const location = normalizeClickUpLocation(value)
      const record = asRecord(value)
      if (!location || record?.archived === true) {
        return []
      }
      return [
        {
          ...location,
          workspaceId: client.workspace.id,
          statuses: Array.isArray(record?.statuses)
            ? record.statuses.map(normalizeClickUpStatus)
            : []
        }
      ]
    })
  })
}

function listsForSpace(
  client: ClickUpClientForWorkspace,
  space: { id: string; name: string }
): Promise<ClickUpList[]> {
  // Why two calls per Space: GET /space/{id}/folder already embeds each Folder's
  // Lists, so only folderless Lists need their own request. Walking every Folder
  // separately cost a request per Folder and tripped 429 in large Workspaces.
  return cached(spaceListCache, cacheKey(client, space.id), async () => {
    const spaceId = encodeURIComponent(space.id)
    const [folderResponse, folderlessResponse] = await Promise.all([
      clickUpRequest<{ folders?: unknown[] }>(client, `/space/${spaceId}/folder?archived=false`),
      clickUpRequest<{ lists?: unknown[] }>(client, `/space/${spaceId}/list?archived=false`)
    ])
    const folderLists = (folderResponse.folders ?? []).flatMap((folderValue) => {
      const record = asRecord(folderValue)
      const folder = normalizeClickUpLocation(folderValue)
      return folder && record?.archived !== true
        ? normalizeLists(record?.lists, client, space, folder)
        : []
    })
    return [...normalizeLists(folderlessResponse.lists, client, space), ...folderLists]
  })
}

async function listsForWorkspace(
  client: ClickUpClientForWorkspace,
  spaceId?: string | null
): Promise<ClickUpList[]> {
  const spaces = await spacesForWorkspace(client)
  const selected = spaceId ? spaces.filter((space) => space.id === spaceId) : spaces
  const lists = await Promise.all(selected.map((space) => listsForSpace(client, space)))
  return lists.flat()
}

function getListForWorkspace(
  client: ClickUpClientForWorkspace,
  listId: string
): Promise<ClickUpList[]> {
  // Hierarchy summaries can omit statuses; only the List endpoint supplies its full workflow.
  return cached(listDetailCache, cacheKey(client, listId), async () => {
    const response = await clickUpRequest<unknown>(client, `/list/${encodeURIComponent(listId)}`)
    const list = normalizeList(response, client)
    return list ? [list] : []
  })
}

function listSortKey(list: ClickUpList): string {
  return `${list.workspaceName ?? ''}\u0000${list.space?.name ?? ''}\u0000${list.folder?.name ?? ''}\u0000${list.name}`
}

// Lists the Workspace's Lists. listId reads just that List (one request, for
// callers that need only its statuses); spaceId walks only that Space.
export async function listClickUpLists(
  workspaceId?: ClickUpWorkspaceSelection | null,
  listId?: string | null,
  spaceId?: string | null
): Promise<ClickUpList[]> {
  const clients = requireClickUpClients(workspaceId)
  const lists = await Promise.all(
    clients.map((client) =>
      listId ? getListForWorkspace(client, listId) : listsForWorkspace(client, spaceId)
    )
  )
  return lists.flat().sort((a, b) => listSortKey(a).localeCompare(listSortKey(b)))
}

export async function listClickUpSpaces(
  workspaceId?: ClickUpWorkspaceSelection | null
): Promise<ClickUpSpace[]> {
  const spaces = await Promise.all(requireClickUpClients(workspaceId).map(spacesForWorkspace))
  return spaces.flat().sort((a, b) => a.name.localeCompare(b.name))
}
