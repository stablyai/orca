import { ipcRenderer } from 'electron'
import type { OdooApi } from './odoo-api'
import type {
  OdooAttachmentUpload,
  OdooComment,
  OdooConnectionStatus,
  OdooCreateTicketResult,
  OdooMentionSuggestion,
  OdooMutationResult,
  OdooPriority,
  OdooProject,
  OdooStage,
  OdooTag,
  OdooTicket,
  OdooTicketFilter,
  OdooTicketUpdate,
  OdooUser,
  OdooViewer
} from '../../shared/odoo-types'

export const odooApi = {
  connect: (args: {
    serverUrl: string
    database: string
    login: string
    apiKey: string
  }): Promise<{ ok: true; viewer: OdooViewer } | { ok: false; error: string }> =>
    ipcRenderer.invoke('odoo:connect', args),

  disconnect: (args?: { instanceId?: string }): Promise<void> =>
    ipcRenderer.invoke('odoo:disconnect', args),

  selectInstance: (args: { instanceId: string }): Promise<OdooConnectionStatus> =>
    ipcRenderer.invoke('odoo:selectInstance', args),

  status: (): Promise<OdooConnectionStatus> => ipcRenderer.invoke('odoo:status'),

  testConnection: (args?: {
    instanceId?: string
  }): Promise<{ ok: true; viewer: OdooViewer } | { ok: false; error: string }> =>
    ipcRenderer.invoke('odoo:testConnection', args),

  listTickets: (args?: {
    filter?: OdooTicketFilter
    limit?: number
    instanceId?: string
  }): Promise<OdooTicket[]> => ipcRenderer.invoke('odoo:listTickets', args),

  searchTickets: (args: {
    domain: unknown[]
    limit?: number
    instanceId?: string
  }): Promise<OdooTicket[]> => ipcRenderer.invoke('odoo:searchTickets', args),

  getTicket: (args: { id: number; instanceId?: string }): Promise<OdooTicket | null> =>
    ipcRenderer.invoke('odoo:getTicket', args),

  createTicket: (args: {
    instanceId?: string
    projectId: number
    title: string
    description?: string
    priority?: OdooPriority
    stageId?: number
    assigneeIds?: number[]
  }): Promise<OdooCreateTicketResult> => ipcRenderer.invoke('odoo:createTicket', args),

  updateTicket: (args: {
    id: number
    updates: OdooTicketUpdate
    instanceId?: string
  }): Promise<OdooMutationResult> => ipcRenderer.invoke('odoo:updateTicket', args),

  addTicketComment: (args: {
    id: number
    body: string
    isNote?: boolean
    instanceId?: string
    mentionPartnerIds?: number[]
    attachmentIds?: number[]
  }): Promise<OdooMutationResult> => ipcRenderer.invoke('odoo:addTicketComment', args),

  updateTicketComment: (args: {
    id: number
    body: string
    instanceId?: string
  }): Promise<OdooMutationResult> => ipcRenderer.invoke('odoo:updateTicketComment', args),

  ticketComments: (args: { id: number; instanceId?: string }): Promise<OdooComment[]> =>
    ipcRenderer.invoke('odoo:ticketComments', args),

  searchMentionCandidates: (args: {
    ticketId: number
    query?: string
    instanceId?: string
  }): Promise<OdooMentionSuggestion[]> => ipcRenderer.invoke('odoo:searchMentionCandidates', args),

  uploadTicketAttachments: (args: {
    ticketId: number
    files: OdooAttachmentUpload[]
    instanceId?: string
  }): Promise<{ ok: true; ids: number[] } | { ok: false; error: string }> =>
    ipcRenderer.invoke('odoo:uploadTicketAttachments', args),

  listProjects: (args?: { instanceId?: string }): Promise<OdooProject[]> =>
    ipcRenderer.invoke('odoo:listProjects', args),

  listStages: (args: { projectId: number; instanceId?: string }): Promise<OdooStage[]> =>
    ipcRenderer.invoke('odoo:listStages', args),

  listTags: (args?: { instanceId?: string }): Promise<OdooTag[]> =>
    ipcRenderer.invoke('odoo:listTags', args),

  listStageNames: (args?: { instanceId?: string }): Promise<string[]> =>
    ipcRenderer.invoke('odoo:listStageNames', args),

  listAssignableUsers: (args?: { query?: string; instanceId?: string }): Promise<OdooUser[]> =>
    ipcRenderer.invoke('odoo:listAssignableUsers', args)
} satisfies OdooApi
