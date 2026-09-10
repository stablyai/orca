import type {
  OdooAttachmentUpload,
  OdooConnectArgs,
  OdooCreateTicketArgs,
  OdooInstanceSelection,
  OdooTicketFilter,
  OdooTicketUpdate
} from '../../shared/odoo-types'
import { connect, disconnect, getStatus, selectInstance, testConnection } from '../odoo/client'
import {
  addTicketComment,
  getTicketComments,
  searchMentionCandidates,
  updateTicketComment,
  uploadTicketAttachments
} from '../odoo/ticket-chatter'
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

export class RuntimeOdooCommands {
  odooConnect(args: OdooConnectArgs): ReturnType<typeof connect> {
    return connect(args)
  }

  odooDisconnect(instanceId?: string): { ok: true } {
    disconnect(instanceId)
    return { ok: true }
  }

  odooSelectInstance(instanceId: OdooInstanceSelection): ReturnType<typeof getStatus> {
    return selectInstance(instanceId)
  }

  odooStatus(): ReturnType<typeof getStatus> {
    return getStatus()
  }

  odooTestConnection(instanceId?: string): ReturnType<typeof testConnection> {
    return testConnection(instanceId)
  }

  odooListTickets(
    filter?: OdooTicketFilter,
    limit = 30,
    instanceId?: OdooInstanceSelection
  ): ReturnType<typeof listTickets> {
    return listTickets(filter, Math.min(Math.max(1, limit), 100), instanceId)
  }

  odooSearchTickets(
    domain: unknown[],
    limit = 30,
    instanceId?: OdooInstanceSelection
  ): ReturnType<typeof searchTickets> {
    return searchTickets(domain, Math.min(Math.max(1, limit), 100), instanceId)
  }

  odooGetTicket(id: number, instanceId?: string): ReturnType<typeof getTicket> {
    return getTicket(id, instanceId)
  }

  odooCreateTicket(args: OdooCreateTicketArgs): ReturnType<typeof createTicket> {
    return createTicket(args)
  }

  odooUpdateTicket(
    id: number,
    updates: OdooTicketUpdate,
    instanceId?: string
  ): ReturnType<typeof updateTicket> {
    return updateTicket(id, updates, instanceId)
  }

  odooAddTicketComment(
    id: number,
    body: string,
    isNote?: boolean,
    instanceId?: string,
    mentionPartnerIds?: number[],
    attachmentIds?: number[]
  ): ReturnType<typeof addTicketComment> {
    return addTicketComment(id, body, isNote, instanceId, mentionPartnerIds, attachmentIds)
  }

  odooUpdateTicketComment(
    id: number,
    body: string,
    instanceId?: string
  ): ReturnType<typeof updateTicketComment> {
    return updateTicketComment(id, body, instanceId)
  }

  odooTicketComments(id: number, instanceId?: string): ReturnType<typeof getTicketComments> {
    return getTicketComments(id, instanceId)
  }

  odooSearchMentionCandidates(
    ticketId: number,
    query: string,
    instanceId?: string
  ): ReturnType<typeof searchMentionCandidates> {
    return searchMentionCandidates(ticketId, query, instanceId)
  }

  odooUploadTicketAttachments(
    ticketId: number,
    files: OdooAttachmentUpload[],
    instanceId?: string
  ): ReturnType<typeof uploadTicketAttachments> {
    return uploadTicketAttachments(ticketId, files, instanceId)
  }

  odooListProjects(instanceId?: OdooInstanceSelection): ReturnType<typeof listProjects> {
    return listProjects(instanceId)
  }

  odooListStages(projectId: number, instanceId?: string): ReturnType<typeof listStages> {
    return listStages(projectId, instanceId)
  }

  odooListTags(instanceId?: OdooInstanceSelection): ReturnType<typeof listTags> {
    return listTags(instanceId)
  }

  odooListStageNames(instanceId?: OdooInstanceSelection): ReturnType<typeof listStageNames> {
    return listStageNames(instanceId)
  }

  odooListAssignableUsers(
    query?: string,
    instanceId?: string
  ): ReturnType<typeof listAssignableUsers> {
    return listAssignableUsers(query, instanceId)
  }
}
