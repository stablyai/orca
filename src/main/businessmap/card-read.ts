import type {
  BusinessmapCard,
  BusinessmapCardFilter,
  BusinessmapComment
} from '../../shared/businessmap-types'
import { getBoardTree } from './boards'
import { acquire, noteRateLimitRejection, release } from './request-queue'
import {
  BusinessmapApiError,
  asNumber,
  asRecord,
  asString,
  asStringArray,
  businessmapRead,
  isAuthError,
  isRateLimitError,
  unwrapList,
  unwrapSingle
} from './authenticated-request'
import type { ApiRecord, BusinessmapClientForSite } from './authenticated-request'
import { clearToken, getClients } from './client'

export const CARD_FIELDS = [
  'card_id',
  'board_id',
  'workflow_id',
  'title',
  'description',
  'column_id',
  'lane_id',
  'owner_user_id',
  'custom_id',
  'type_id',
  'color',
  'section',
  'size',
  'priority',
  'deadline',
  'created_at',
  'last_modified',
  'is_blocked'
].join(',')

export type CardNameTables = {
  usersById: Map<number, string>
  columnsById: Map<number, string>
  lanesById: Map<number, string>
}

export function asId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return null
}

export function cardUrl(
  site: BusinessmapClientForSite['site'],
  boardId: number,
  cardId: number
): string {
  const domain = site.domain === 'kanbanize.com' ? 'kanbanize.com' : 'businessmap.io'
  return `https://${site.subdomain}.${domain}/ctrl_board/${boardId}/cards/${cardId}/details/`
}

export function mapCard(
  site: BusinessmapClientForSite['site'],
  raw: unknown,
  names: CardNameTables,
  boardFallback: number | null
): BusinessmapCard | null {
  const record = asRecord(raw)
  const id = asId(record.card_id ?? record.id)
  const boardId = asId(record.board_id) ?? boardFallback
  const title = asString(record.title)
  if (id === null || boardId === null || !title) {
    return null
  }
  const columnId = asId(record.column_id) ?? 0
  const laneId = asId(record.lane_id)
  const ownerId = asId(record.owner_user_id)
  const updatedAt =
    asString(record.last_modified) || asString(record.updated_at) || new Date().toISOString()
  const card: BusinessmapCard = {
    id,
    boardId,
    title,
    url: cardUrl(site, boardId, id),
    column: { id: columnId, name: names.columnsById.get(columnId) ?? String(columnId) },
    workflowId: asId(record.workflow_id) ?? 0,
    labels: asStringArray(record.tag_ids ?? record.tags),
    updatedAt
  }
  const description = asString(record.description)
  if (description) {
    card.description = description
  }
  if (laneId !== null) {
    card.lane = { id: laneId, name: names.lanesById.get(laneId) ?? String(laneId) }
  }
  if (ownerId !== null) {
    card.assignee = { id: ownerId, displayName: names.usersById.get(ownerId) ?? String(ownerId) }
  }
  const createdAt = asString(record.created_at)
  if (createdAt) {
    card.createdAt = createdAt
  }
  return card
}

export function mapComment(record: ApiRecord): BusinessmapComment | null {
  const id = asId(record.comment_id ?? record.id)
  const body = asString(record.text ?? record.body)
  if (id === null || !body) {
    return null
  }
  const comment: BusinessmapComment = {
    id,
    body,
    createdAt: asString(record.created_at) || new Date().toISOString()
  }
  const displayName = asString(asRecord(record.user ?? record.author).realname)
  if (displayName) {
    comment.user = { displayName }
  }
  return comment
}

// One GET /users call resolves display names; never one lookup per card.
async function loadUserNames(
  entry: BusinessmapClientForSite,
  ids: number[]
): Promise<Map<number, string>> {
  const names = new Map<number, string>()
  const unique = [...new Set(ids)]
  if (unique.length === 0) {
    return names
  }
  await acquire()
  try {
    const params = new URLSearchParams({
      user_ids: unique.join(','),
      fields: 'user_id,realname,email'
    })
    const payload = await businessmapRead(entry, `/users?${params.toString()}`)
    for (const raw of unwrapList(payload)) {
      const record = asRecord(raw)
      const id = asId(record.user_id ?? record.id)
      if (id === null) {
        continue
      }
      names.set(id, asString(record.realname) || asString(record.email) || String(id))
    }
  } catch (error) {
    // Names are best-effort; cards still resolve with numeric fallbacks.
    console.warn('[businessmap] user lookup failed:', error)
  } finally {
    release()
  }
  return names
}

export async function loadNameTables(
  entry: BusinessmapClientForSite,
  raws: unknown[],
  boardId: number | null
): Promise<CardNameTables> {
  const userIds: number[] = []
  const boardIds = new Set<number>()
  if (boardId !== null) {
    boardIds.add(boardId)
  }
  for (const raw of raws) {
    const record = asRecord(raw)
    const ownerId = asId(record.owner_user_id)
    if (ownerId !== null) {
      userIds.push(ownerId)
    }
    const rawBoardId = asId(record.board_id)
    if (rawBoardId !== null) {
      boardIds.add(rawBoardId)
    }
  }
  const usersById = await loadUserNames(entry, userIds)
  const columnsById = new Map<number, string>()
  const lanesById = new Map<number, string>()
  // Board structure gives column/lane names; cached 1h per account.
  for (const id of [...boardIds].slice(0, 5)) {
    const tree = await getBoardTree(id, entry.site.id).catch(() => null)
    if (!tree) {
      continue
    }
    for (const column of Object.values(tree.columnsById)) {
      columnsById.set(column.id, column.name)
    }
    for (const lane of Object.values(tree.lanesById)) {
      lanesById.set(lane.id, lane.name)
    }
  }
  return { usersById, columnsById, lanesById }
}

export function clampLimit(limit: number | undefined, fallback = 30): number {
  return Math.min(Math.max(1, Number.isFinite(limit) ? Number(limit) : fallback), 100)
}

export function filterParams(
  filter: BusinessmapCardFilter,
  viewerId: number | null
): URLSearchParams {
  const params = new URLSearchParams({ fields: CARD_FIELDS, per_page: '100' })
  if (filter === 'done') {
    params.set('sections', '4')
  } else if (filter === 'assigned' && viewerId !== null) {
    params.set('owner_user_ids', String(viewerId))
  }
  return params
}

export async function currentUserId(entry: BusinessmapClientForSite): Promise<number | null> {
  await acquire()
  try {
    const me = unwrapSingle(await businessmapRead(entry, '/me'))
    return asId(asRecord(me).user_id ?? asRecord(me).id)
  } catch {
    return null
  } finally {
    release()
  }
}
// Reads data.pagination.all_pages without trusting the envelope shape.
function readAllPages(payload: unknown): number | null {
  const envelope = asRecord(payload).data
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return null
  }
  const pagination = asRecord(envelope).pagination
  if (!pagination || typeof pagination !== 'object' || Array.isArray(pagination)) {
    return null
  }
  return asNumber(asRecord(pagination).all_pages)
}

export async function fetchCardPages(
  entry: BusinessmapClientForSite,
  base: URLSearchParams,
  boardId: number | null,
  maxRows: number | null = null
): Promise<unknown[]> {
  const raws: unknown[] = []
  let page = 1
  for (let guard = 0; guard < 20; guard += 1) {
    const params = new URLSearchParams(base)
    if (boardId !== null) {
      params.set('board_ids', String(boardId))
    }
    params.set('page', String(page))
    await acquire()
    let payload: unknown
    try {
      payload = await businessmapRead(entry, `/cards?${params.toString()}`)
    } finally {
      release()
    }
    const items = unwrapList(payload)
    raws.push(...items)
    // List stops at its row budget; search (maxRows null) walks every page.
    if (maxRows !== null && raws.length >= maxRows) {
      break
    }
    const paging = readAllPages(payload)
    if (paging === null || page >= paging || items.length === 0) {
      break
    }
    page += 1
  }
  return raws
}

export function noteQuota(error: unknown): void {
  if (!isRateLimitError(error)) {
    return
  }
  // RL02 requests are rejected before running, so pausing briefly is safe.
  const retryAfter = error instanceof BusinessmapApiError ? error.retryAfterSeconds : null
  noteRateLimitRejection(retryAfter)
}

export function surfaceReadError(
  error: unknown,
  entry: BusinessmapClientForSite,
  entryCount: number
): BusinessmapCard[] {
  noteQuota(error)
  if (isAuthError(error)) {
    clearToken(entry.site.id)
    if (entryCount <= 1) {
      throw error
    }
  } else {
    console.warn('[businessmap] card read failed:', error)
  }
  return []
}

export function getClientEntries(siteId?: string | null): BusinessmapClientForSite[] {
  return getClients(siteId ?? undefined)
}
