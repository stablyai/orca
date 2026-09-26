import { ipcMain } from 'electron'
import { connect, disconnect, getStatus, selectSite, testConnection } from '../businessmap/client'
import { _resetPreflightCache } from './preflight'
import {
  addCardComment,
  createCard,
  getBoardTree,
  getCard,
  getCardComments,
  listBoards,
  listCards,
  searchCards,
  updateCard
} from '../businessmap/issues'
import type {
  BusinessmapCardFilter,
  BusinessmapCardUpdate,
  BusinessmapConnectArgs,
  BusinessmapCreateCardArgs,
  BusinessmapDomain
} from '../../shared/businessmap-types'

const VALID_FILTERS: Record<string, BusinessmapCardFilter> = {
  assigned: 'assigned',
  all: 'all',
  done: 'done'
}

function normalizeSiteId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function clampLimit(value: unknown, fallback = 30): number {
  const limit = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(Math.max(1, limit), 100)
}

function clampBoardId(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return undefined
}

function clampCardId(value: unknown): number | null {
  const id = clampBoardId(value)
  return id === undefined ? null : id
}

function normalizeDomain(value: unknown): BusinessmapDomain | undefined {
  return value === 'businessmap.io' || value === 'kanbanize.com' ? value : undefined
}

/** Narrows an untrusted IPC payload to the card-update fields the host accepts. */
function normalizeCardUpdate(value: unknown): BusinessmapCardUpdate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const record: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    record[key] = entry
  }
  const updates: BusinessmapCardUpdate = {}
  if (record.title !== undefined) {
    if (typeof record.title !== 'string') {
      return null
    }
    updates.title = record.title
  }
  if (record.description !== undefined) {
    if (typeof record.description !== 'string') {
      return null
    }
    updates.description = record.description
  }
  if (record.columnId !== undefined) {
    const columnId = clampBoardId(record.columnId)
    if (columnId === undefined) {
      return null
    }
    updates.columnId = columnId
  }
  if (record.laneId !== undefined) {
    const laneId = clampBoardId(record.laneId)
    if (laneId === undefined) {
      return null
    }
    updates.laneId = laneId
  }
  if (record.reason !== undefined) {
    if (typeof record.reason !== 'string') {
      return null
    }
    updates.reason = record.reason
  }
  return updates
}

/** Registers every `businessmap:*` IPC handler on the main process. */
export function registerBusinessmapHandlers(): void {
  ipcMain.handle('businessmap:connect', async (_event, args: BusinessmapConnectArgs) => {
    if (typeof args?.subdomain !== 'string' || typeof args?.apiKey !== 'string') {
      return { ok: false, error: 'Subdomain and API key are required.' }
    }
    const domain = normalizeDomain(args.domain)
    const result = await connect({
      subdomain: args.subdomain,
      apiKey: args.apiKey,
      ...(domain ? { domain } : {})
    })
    if (result.ok) {
      _resetPreflightCache()
    }
    return result
  })

  ipcMain.handle('businessmap:disconnect', async (_event, args?: { siteId?: string }) => {
    disconnect(normalizeSiteId(args?.siteId))
    _resetPreflightCache()
  })

  ipcMain.handle('businessmap:selectSite', async (_event, args: { siteId: string }) => {
    const siteId = normalizeSiteId(args?.siteId)
    if (!siteId) {
      return getStatus()
    }
    return selectSite(siteId)
  })

  ipcMain.handle('businessmap:status', async () => {
    return getStatus()
  })

  ipcMain.handle('businessmap:readStatus', async () => {
    return getStatus()
  })

  ipcMain.handle('businessmap:testConnection', async (_event, args?: { siteId?: string }) => {
    return testConnection(normalizeSiteId(args?.siteId))
  })

  ipcMain.handle(
    'businessmap:searchCards',
    async (_event, args: { query: string; limit?: number; siteId?: string; boardId?: number }) => {
      if (typeof args?.query !== 'string') {
        return []
      }
      return searchCards(
        args.query,
        clampLimit(args.limit),
        normalizeSiteId(args.siteId),
        clampBoardId(args?.boardId) ?? null
      )
    }
  )

  ipcMain.handle(
    'businessmap:listCards',
    async (
      _event,
      args?: { filter?: BusinessmapCardFilter; limit?: number; siteId?: string; boardId?: number }
    ) => {
      const filter = args?.filter !== undefined ? VALID_FILTERS[args.filter] : undefined
      return listCards(
        filter,
        clampLimit(args?.limit),
        normalizeSiteId(args?.siteId),
        clampBoardId(args?.boardId) ?? null
      )
    }
  )

  ipcMain.handle('businessmap:getCard', async (_event, args: { id: number; siteId?: string }) => {
    const id = clampCardId(args?.id)
    if (id === null) {
      return null
    }
    return getCard(id, normalizeSiteId(args?.siteId))
  })

  ipcMain.handle(
    'businessmap:createCard',
    async (_event, args: BusinessmapCreateCardArgs & { siteId?: string }) => {
      const boardId = clampBoardId(args?.boardId)
      if (boardId === undefined) {
        return { ok: false, error: 'Board is required.' }
      }
      const title = typeof args?.title === 'string' ? args.title.trim() : ''
      if (!title) {
        return { ok: false, error: 'Title is required.' }
      }
      const description = typeof args.description === 'string' ? args.description.trim() : ''
      const columnId = clampBoardId(args.columnId)
      const laneId = clampBoardId(args.laneId)
      return createCard(
        {
          boardId,
          title,
          ...(description ? { description } : {}),
          ...(columnId !== undefined ? { columnId } : {}),
          ...(laneId !== undefined ? { laneId } : {})
        },
        normalizeSiteId(args.siteId)
      )
    }
  )

  ipcMain.handle(
    'businessmap:updateCard',
    async (_event, args: { id: number; updates: BusinessmapCardUpdate; siteId?: string }) => {
      const id = clampCardId(args?.id)
      if (id === null) {
        return { ok: false, error: 'Card id is required.' }
      }
      const updates = normalizeCardUpdate(args.updates)
      if (!updates) {
        return { ok: false, error: 'Updates object is required.' }
      }
      return updateCard(id, updates, normalizeSiteId(args.siteId))
    }
  )

  ipcMain.handle(
    'businessmap:addCardComment',
    async (_event, args: { id: number; body: string; siteId?: string }) => {
      const id = clampCardId(args?.id)
      if (id === null) {
        return { ok: false, error: 'Card id is required.' }
      }
      if (typeof args?.body !== 'string' || !args.body.trim()) {
        return { ok: false, error: 'Comment body is required.' }
      }
      return addCardComment(id, args.body.trim(), normalizeSiteId(args.siteId))
    }
  )

  ipcMain.handle(
    'businessmap:issueComments',
    async (_event, args: { id: number; siteId?: string }) => {
      const id = clampCardId(args?.id)
      if (id === null) {
        return []
      }
      return getCardComments(id, normalizeSiteId(args.siteId))
    }
  )

  ipcMain.handle('businessmap:listBoards', async (_event, args?: { siteId?: string }) => {
    return listBoards(normalizeSiteId(args?.siteId))
  })

  ipcMain.handle(
    'businessmap:getBoardTree',
    async (_event, args: { boardId: number; siteId?: string }) => {
      const boardId = clampBoardId(args?.boardId)
      if (boardId === undefined) {
        return null
      }
      return getBoardTree(boardId, normalizeSiteId(args?.siteId))
    }
  )
}
