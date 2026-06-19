import { ipcMain } from 'electron'
import { connect, disconnect, getStatus, selectServer, testConnection } from '../glpi/connect'
import {
  addGlpiTicketFollowup,
  createGlpiTicketOnServer,
  getGlpiTicketDetail,
  getGlpiTicketFollowups,
  listGlpiWorkItems,
  updateGlpiTicketDetail
} from '../glpi/ticket-operations'
import { _resetPreflightCache } from './preflight'
import type {
  GlpiConnectArgs,
  GlpiCreateTicketArgs,
  GlpiServerSelection,
  GlpiTicketFilter,
  GlpiTicketStatus,
  GlpiTicketType,
  GlpiTicketUpdate,
  GlpiWorkItemFilters
} from '../../shared/types'

const VALID_FILTERS = new Set<GlpiTicketFilter>(['assigned', 'created', 'all', 'closed'])
const VALID_STATUSES = new Set<GlpiTicketStatus>([
  'new',
  'assigned',
  'planned',
  'pending',
  'solved',
  'closed'
])

function normalizeServerId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeServerSelection(value: unknown): GlpiServerSelection | undefined {
  return normalizeServerId(value) as GlpiServerSelection | undefined
}

function clampLimit(value: unknown, fallback = 30): number {
  const limit = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(Math.max(1, limit), 100)
}

function normalizeTicketId(value: unknown): number | null {
  const id = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

// GLPI urgency is a 1 (very low) .. 5 (very high) scale.
function normalizeUrgency(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }
  return Math.min(Math.max(1, Math.round(value)), 5)
}

function normalizeNonEmptyText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

// Drops any invalid field rather than rejecting the whole object, and returns
// undefined when nothing valid remains so callers skip the filter entirely.
function normalizeWorkItemFilters(value: unknown): GlpiWorkItemFilters | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const input = value as Partial<GlpiWorkItemFilters>
  const filters: GlpiWorkItemFilters = {}
  if (input.type === 'incident' || input.type === 'request') {
    filters.type = input.type
  }
  const text = normalizeNonEmptyText(input.text)
  if (text) {
    filters.text = text
  }
  const category = normalizeNonEmptyText(input.category)
  if (category) {
    filters.category = category
  }
  // GLPI priority is a 1 (very low) .. 5 (very high) scale.
  if (typeof input.priority === 'number' && Number.isInteger(input.priority)) {
    filters.priority = Math.min(Math.max(1, input.priority), 5)
  }
  return Object.keys(filters).length > 0 ? filters : undefined
}

function normalizeUpdate(value: unknown): GlpiTicketUpdate | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const input = value as GlpiTicketUpdate
  if (input.title !== undefined && typeof input.title !== 'string') {
    return null
  }
  if (input.content !== undefined && typeof input.content !== 'string') {
    return null
  }
  if (input.status !== undefined && !VALID_STATUSES.has(input.status)) {
    return null
  }
  return input
}

export function registerGlpiHandlers(): void {
  ipcMain.handle('glpi:connect', async (_event, args: GlpiConnectArgs) => {
    if (
      typeof args?.baseUrl !== 'string' ||
      typeof args?.appToken !== 'string' ||
      typeof args?.userToken !== 'string'
    ) {
      return { ok: false, error: 'URL, application token, and user API token are required.' }
    }
    const result = await connect({
      baseUrl: args.baseUrl,
      appToken: args.appToken,
      userToken: args.userToken
    })
    if (result.ok) {
      _resetPreflightCache()
    }
    return result
  })

  ipcMain.handle('glpi:disconnect', async (_event, args?: { serverId?: string }) => {
    disconnect(normalizeServerId(args?.serverId))
    _resetPreflightCache()
  })

  ipcMain.handle('glpi:selectServer', async (_event, args: { serverId: GlpiServerSelection }) => {
    const serverId = normalizeServerSelection(args?.serverId)
    if (!serverId) {
      return getStatus()
    }
    return selectServer(serverId)
  })

  ipcMain.handle('glpi:status', async () => {
    return getStatus()
  })

  ipcMain.handle('glpi:testConnection', async (_event, args?: { serverId?: string }) => {
    return testConnection(normalizeServerId(args?.serverId))
  })

  ipcMain.handle(
    'glpi:listWorkItems',
    async (
      _event,
      args?: {
        serverId?: GlpiServerSelection
        filter?: GlpiTicketFilter
        limit?: number
        filters?: GlpiWorkItemFilters
      }
    ) => {
      const filter = VALID_FILTERS.has(args?.filter as GlpiTicketFilter)
        ? (args!.filter as GlpiTicketFilter)
        : 'all'
      return listGlpiWorkItems(
        normalizeServerSelection(args?.serverId) ?? null,
        filter,
        clampLimit(args?.limit),
        normalizeWorkItemFilters(args?.filters)
      )
    }
  )

  ipcMain.handle('glpi:ticket', async (_event, args: { serverId?: string; id: number }) => {
    const id = normalizeTicketId(args?.id)
    if (id === null) {
      return null
    }
    return getGlpiTicketDetail(normalizeServerId(args?.serverId) ?? null, id)
  })

  ipcMain.handle('glpi:followups', async (_event, args: { serverId?: string; id: number }) => {
    const id = normalizeTicketId(args?.id)
    if (id === null) {
      return []
    }
    return getGlpiTicketFollowups(normalizeServerId(args?.serverId) ?? null, id)
  })

  ipcMain.handle(
    'glpi:addFollowup',
    async (_event, args: { serverId?: string; id: number; content: string }) => {
      const id = normalizeTicketId(args?.id)
      if (id === null) {
        return { ok: false, error: 'Ticket id is required.' }
      }
      if (typeof args?.content !== 'string' || !args.content.trim()) {
        return { ok: false, error: 'Followup content is required.' }
      }
      return addGlpiTicketFollowup(
        normalizeServerId(args?.serverId) ?? null,
        id,
        args.content.trim()
      )
    }
  )

  ipcMain.handle(
    'glpi:updateTicket',
    async (_event, args: { serverId?: string; id: number; updates: GlpiTicketUpdate }) => {
      const id = normalizeTicketId(args?.id)
      if (id === null) {
        return { ok: false, error: 'Ticket id is required.' }
      }
      const updates = normalizeUpdate(args?.updates)
      if (!updates) {
        return { ok: false, error: 'Updates object is required.' }
      }
      return updateGlpiTicketDetail(normalizeServerId(args?.serverId) ?? null, id, updates)
    }
  )

  ipcMain.handle('glpi:createTicket', async (_event, args: GlpiCreateTicketArgs) => {
    if (typeof args?.title !== 'string' || !args.title.trim()) {
      return { ok: false, error: 'Title is required.' }
    }
    const type: GlpiTicketType | undefined =
      args.type === 'incident' || args.type === 'request' ? args.type : undefined
    return createGlpiTicketOnServer({
      serverId: normalizeServerId(args.serverId),
      title: args.title.trim(),
      content: typeof args.content === 'string' ? args.content : undefined,
      type,
      urgency: normalizeUrgency(args.urgency)
    })
  })
}
