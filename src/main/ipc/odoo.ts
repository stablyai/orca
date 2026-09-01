import { ipcMain } from 'electron'
import { connect, disconnect, getStatus, selectInstance, testConnection } from '../odoo/client'
import {
  createTicket,
  getTicket,
  listAssignableUsers,
  listProjects,
  listStageNames,
  listStages,
  listTags,
  listTickets,
  searchTickets,
  updateTicket
} from '../odoo/tickets'
import { ODOO_PRIORITIES, ODOO_TICKET_STATES } from '../../shared/odoo-types'
import {
  clampLimit,
  normalizeIdArray,
  normalizeInstanceId,
  normalizeInstanceSelection,
  normalizeRecordId
} from './odoo-ipc-args'
import { registerOdooTicketChatterHandlers } from './odoo-ticket-chatter'
import type {
  OdooConnectArgs,
  OdooCreateTicketArgs,
  OdooInstanceSelection,
  OdooPriority,
  OdooTicketFilter,
  OdooTicketState,
  OdooTicketUpdate
} from '../../shared/odoo-types'
const VALID_FILTERS = new Set<OdooTicketFilter>(['assigned', 'reported', 'all', 'done'])
const VALID_PRIORITIES = new Set<OdooPriority>(ODOO_PRIORITIES)
const VALID_STATES = new Set<OdooTicketState>(ODOO_TICKET_STATES)

function normalizeTicketUpdate(value: unknown): OdooTicketUpdate | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const input = value as OdooTicketUpdate
  if (input.title !== undefined && typeof input.title !== 'string') {
    return null
  }
  if (input.description !== undefined && typeof input.description !== 'string') {
    return null
  }
  if (input.stageId !== undefined && normalizeRecordId(input.stageId) === null) {
    return null
  }
  if (input.priority !== undefined && !VALID_PRIORITIES.has(input.priority)) {
    return null
  }
  if (input.state !== undefined && !VALID_STATES.has(input.state)) {
    return null
  }
  if (input.assigneeIds !== undefined && normalizeIdArray(input.assigneeIds) === undefined) {
    return null
  }
  if (input.tagIds !== undefined && normalizeIdArray(input.tagIds) === undefined) {
    return null
  }
  if (
    input.deadline !== undefined &&
    input.deadline !== null &&
    typeof input.deadline !== 'string'
  ) {
    return null
  }
  return input
}

export function registerOdooHandlers(): void {
  ipcMain.handle('odoo:connect', async (_event, args: OdooConnectArgs) => {
    if (
      typeof args?.serverUrl !== 'string' ||
      typeof args?.database !== 'string' ||
      typeof args?.login !== 'string' ||
      typeof args?.apiKey !== 'string'
    ) {
      return { ok: false, error: 'Server URL, database, login, and API key are required.' }
    }
    return connect({
      serverUrl: args.serverUrl,
      database: args.database,
      login: args.login,
      apiKey: args.apiKey
    })
  })

  ipcMain.handle('odoo:disconnect', async (_event, args?: { instanceId?: string }) => {
    disconnect(normalizeInstanceId(args?.instanceId))
  })

  ipcMain.handle(
    'odoo:selectInstance',
    async (_event, args: { instanceId: OdooInstanceSelection }) => {
      const instanceId = normalizeInstanceSelection(args?.instanceId)
      if (!instanceId) {
        return getStatus()
      }
      return selectInstance(instanceId)
    }
  )

  ipcMain.handle('odoo:status', async () => getStatus())

  ipcMain.handle('odoo:testConnection', async (_event, args?: { instanceId?: string }) =>
    testConnection(normalizeInstanceId(args?.instanceId))
  )

  ipcMain.handle(
    'odoo:listTickets',
    async (
      _event,
      args?: { filter?: OdooTicketFilter; limit?: number; instanceId?: OdooInstanceSelection }
    ) => {
      const filter = VALID_FILTERS.has(args?.filter as OdooTicketFilter)
        ? (args?.filter as OdooTicketFilter)
        : undefined
      return listTickets(
        filter,
        clampLimit(args?.limit),
        normalizeInstanceSelection(args?.instanceId)
      )
    }
  )

  ipcMain.handle(
    'odoo:searchTickets',
    async (
      _event,
      args: { domain: unknown[]; limit?: number; instanceId?: OdooInstanceSelection }
    ) => {
      if (!Array.isArray(args?.domain)) {
        return []
      }
      return searchTickets(
        args.domain,
        clampLimit(args.limit),
        normalizeInstanceSelection(args.instanceId)
      )
    }
  )

  ipcMain.handle('odoo:getTicket', async (_event, args: { id: number; instanceId?: string }) => {
    const id = normalizeRecordId(args?.id)
    if (id === null) {
      return null
    }
    return getTicket(id, normalizeInstanceId(args.instanceId))
  })

  ipcMain.handle('odoo:createTicket', async (_event, args: OdooCreateTicketArgs) => {
    const projectId = normalizeRecordId(args?.projectId)
    if (projectId === null) {
      return { ok: false, error: 'Project is required.' }
    }
    if (typeof args?.title !== 'string' || !args.title.trim()) {
      return { ok: false, error: 'Title is required.' }
    }
    return createTicket({
      instanceId: normalizeInstanceId(args.instanceId),
      projectId,
      title: args.title.trim(),
      description: args.description?.trim() || undefined,
      priority: VALID_PRIORITIES.has(args.priority as OdooPriority) ? args.priority : undefined,
      stageId: normalizeRecordId(args.stageId) ?? undefined,
      assigneeIds: normalizeIdArray(args.assigneeIds)
    })
  })

  ipcMain.handle(
    'odoo:updateTicket',
    async (_event, args: { id: number; updates: OdooTicketUpdate; instanceId?: string }) => {
      const id = normalizeRecordId(args?.id)
      if (id === null) {
        return { ok: false, error: 'Ticket ID is required.' }
      }
      const updates = normalizeTicketUpdate(args.updates)
      if (!updates) {
        return { ok: false, error: 'Updates object is required.' }
      }
      return updateTicket(id, updates, normalizeInstanceId(args.instanceId))
    }
  )

  registerOdooTicketChatterHandlers()

  ipcMain.handle(
    'odoo:listProjects',
    async (_event, args?: { instanceId?: OdooInstanceSelection }) =>
      listProjects(normalizeInstanceSelection(args?.instanceId))
  )

  ipcMain.handle(
    'odoo:listStages',
    async (_event, args: { projectId: number; instanceId?: string }) => {
      const projectId = normalizeRecordId(args?.projectId)
      if (projectId === null) {
        return []
      }
      return listStages(projectId, normalizeInstanceId(args.instanceId))
    }
  )

  ipcMain.handle('odoo:listTags', async (_event, args?: { instanceId?: OdooInstanceSelection }) =>
    listTags(normalizeInstanceSelection(args?.instanceId))
  )

  ipcMain.handle(
    'odoo:listStageNames',
    async (_event, args?: { instanceId?: OdooInstanceSelection }) =>
      listStageNames(normalizeInstanceSelection(args?.instanceId))
  )

  ipcMain.handle(
    'odoo:listAssignableUsers',
    async (_event, args?: { query?: string; instanceId?: string }) =>
      listAssignableUsers(
        typeof args?.query === 'string' ? args.query : undefined,
        normalizeInstanceId(args?.instanceId)
      )
  )
}
