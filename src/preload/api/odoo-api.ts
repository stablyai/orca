import type {
  OdooAttachmentUpload,
  OdooComment,
  OdooConnectionStatus,
  OdooCreateTicketResult,
  OdooMentionSuggestion,
  OdooPriority,
  OdooMutationResult,
  OdooProject,
  OdooStage,
  OdooTag,
  OdooTicket,
  OdooTicketFilter,
  OdooTicketUpdate,
  OdooUser,
  OdooViewer
} from '../../shared/odoo-types'

export type OdooApi = {
  connect: (args: {
    serverUrl: string
    database: string
    login: string
    apiKey: string
  }) => Promise<{ ok: true; viewer: OdooViewer } | { ok: false; error: string }>
  disconnect: (args?: { instanceId?: string }) => Promise<void>
  selectInstance: (args: { instanceId: string }) => Promise<OdooConnectionStatus>
  status: () => Promise<OdooConnectionStatus>
  testConnection: (args?: {
    instanceId?: string
  }) => Promise<{ ok: true; viewer: OdooViewer } | { ok: false; error: string }>
  listTickets: (args?: {
    filter?: OdooTicketFilter
    limit?: number
    instanceId?: string
  }) => Promise<OdooTicket[]>
  searchTickets: (args: {
    domain: unknown[]
    limit?: number
    instanceId?: string
  }) => Promise<OdooTicket[]>
  getTicket: (args: { id: number; instanceId?: string }) => Promise<OdooTicket | null>
  createTicket: (args: {
    instanceId?: string
    projectId: number
    title: string
    description?: string
    priority?: OdooPriority
    stageId?: number
    assigneeIds?: number[]
  }) => Promise<OdooCreateTicketResult>
  updateTicket: (args: {
    id: number
    updates: OdooTicketUpdate
    instanceId?: string
  }) => Promise<OdooMutationResult>
  addTicketComment: (args: {
    id: number
    body: string
    isNote?: boolean
    instanceId?: string
    mentionPartnerIds?: number[]
    attachmentIds?: number[]
  }) => Promise<OdooMutationResult>
  updateTicketComment: (args: {
    id: number
    body: string
    instanceId?: string
  }) => Promise<OdooMutationResult>
  ticketComments: (args: { id: number; instanceId?: string }) => Promise<OdooComment[]>
  searchMentionCandidates: (args: {
    ticketId: number
    query?: string
    instanceId?: string
  }) => Promise<OdooMentionSuggestion[]>
  uploadTicketAttachments: (args: {
    ticketId: number
    files: OdooAttachmentUpload[]
    instanceId?: string
  }) => Promise<{ ok: true; ids: number[] } | { ok: false; error: string }>
  listProjects: (args?: { instanceId?: string }) => Promise<OdooProject[]>
  listStages: (args: { projectId: number; instanceId?: string }) => Promise<OdooStage[]>
  listTags: (args?: { instanceId?: string }) => Promise<OdooTag[]>
  listStageNames: (args?: { instanceId?: string }) => Promise<string[]>
  listAssignableUsers: (args?: { query?: string; instanceId?: string }) => Promise<OdooUser[]>
}
