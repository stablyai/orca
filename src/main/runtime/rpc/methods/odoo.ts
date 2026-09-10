import { z } from 'zod'
import {
  MAX_ODOO_ATTACHMENT_COUNT,
  ODOO_ATTACHMENT_UPLOAD_MAX_BASE64_LENGTH
} from '../../../../shared/odoo-attachment-upload-limit'
import { ODOO_PRIORITIES, ODOO_TICKET_STATES } from '../../../../shared/odoo-types'
import { defineMethod, type RpcMethod } from '../core'
import {
  OptionalFiniteNumber,
  OptionalPlainString,
  OptionalString,
  requiredString
} from '../schemas'

const VALID_FILTERS = ['assigned', 'reported', 'all', 'done'] as const

const InstanceSelection = z
  .object({
    instanceId: OptionalString
  })
  .optional()

const Connect = z.object({
  serverUrl: requiredString('Server URL is required'),
  database: requiredString('Database is required'),
  login: requiredString('Login is required'),
  apiKey: requiredString('API key is required')
})

const SelectInstance = z.object({
  instanceId: requiredString('Instance ID is required')
})

const TicketId = z.object({
  id: z.number().int().positive(),
  instanceId: OptionalString
})

const ListTickets = z
  .object({
    filter: z.enum(VALID_FILTERS).optional(),
    limit: OptionalFiniteNumber,
    instanceId: OptionalString
  })
  .optional()

const SearchTickets = z.object({
  // An Odoo domain is a heterogeneous array of leaves and operators; its shape
  // is validated server-side by Odoo itself.
  domain: z.array(z.unknown()),
  limit: OptionalFiniteNumber,
  instanceId: OptionalString
})

const CreateTicket = z.object({
  instanceId: OptionalString,
  projectId: z.number().int().positive(),
  title: requiredString('Title is required'),
  description: OptionalPlainString,
  priority: z.enum(ODOO_PRIORITIES).optional(),
  stageId: z.number().int().positive().optional(),
  assigneeIds: z.array(z.number().int().positive()).optional()
})

const UpdateTicket = z.object({
  id: z.number().int().positive(),
  instanceId: OptionalString,
  updates: z.object({
    title: OptionalString,
    description: OptionalString,
    stageId: z.number().int().positive().optional(),
    priority: z.enum(ODOO_PRIORITIES).optional(),
    state: z.enum(ODOO_TICKET_STATES).optional(),
    assigneeIds: z.array(z.number().int().positive()).optional(),
    tagIds: z.array(z.number().int().positive()).optional(),
    deadline: z.union([z.string(), z.null()]).optional()
  })
})

const TicketComment = z.object({
  id: z.number().int().positive(),
  body: requiredString('Comment body is required'),
  isNote: z.boolean().optional(),
  instanceId: OptionalString,
  mentionPartnerIds: z.array(z.number().int().positive()).optional(),
  attachmentIds: z.array(z.number().int().positive()).optional()
})

const UpdateTicketComment = z.object({
  id: z.number().int().positive(),
  body: requiredString('Comment body is required'),
  instanceId: OptionalString
})

const SearchMentionCandidates = z.object({
  ticketId: z.number().int().positive(),
  query: OptionalPlainString,
  instanceId: OptionalString
})

// Why: the upload call caps the batch again, but bounding it here keeps an
// oversized base64 blob from crossing the relay only to be refused at the far end.
const AttachmentUpload = z.object({
  name: requiredString('Attachment name is required'),
  mimetype: requiredString('Attachment mimetype is required'),
  data: requiredString('Attachment data is required').pipe(
    z
      .string()
      .max(ODOO_ATTACHMENT_UPLOAD_MAX_BASE64_LENGTH, 'Attachment exceeds the upload size limit')
  )
})

const UploadTicketAttachments = z.object({
  ticketId: z.number().int().positive(),
  files: z
    .array(AttachmentUpload)
    .max(MAX_ODOO_ATTACHMENT_COUNT, 'Too many attachments in one upload'),
  instanceId: OptionalString
})

const ProjectStages = z.object({
  projectId: z.number().int().positive(),
  instanceId: OptionalString
})

const AssignableUsers = z.object({
  query: OptionalPlainString,
  instanceId: OptionalString
})

export const ODOO_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'odoo.connect',
    params: Connect,
    handler: async (params, { runtime }) =>
      runtime.odooConnect({
        serverUrl: params.serverUrl.trim(),
        database: params.database.trim(),
        login: params.login.trim(),
        apiKey: params.apiKey.trim()
      })
  }),
  defineMethod({
    name: 'odoo.disconnect',
    params: InstanceSelection,
    handler: async (params, { runtime }) => runtime.odooDisconnect(params?.instanceId)
  }),
  defineMethod({
    name: 'odoo.selectInstance',
    params: SelectInstance,
    handler: async (params, { runtime }) => runtime.odooSelectInstance(params.instanceId.trim())
  }),
  defineMethod({
    name: 'odoo.status',
    params: null,
    handler: async (_params, { runtime }) => runtime.odooStatus()
  }),
  defineMethod({
    name: 'odoo.testConnection',
    params: InstanceSelection,
    handler: async (params, { runtime }) => runtime.odooTestConnection(params?.instanceId)
  }),
  defineMethod({
    name: 'odoo.listTickets',
    params: ListTickets,
    handler: async (params, { runtime }) =>
      runtime.odooListTickets(params?.filter, params?.limit, params?.instanceId)
  }),
  defineMethod({
    name: 'odoo.searchTickets',
    params: SearchTickets,
    handler: async (params, { runtime }) =>
      runtime.odooSearchTickets(params.domain, params.limit, params.instanceId)
  }),
  defineMethod({
    name: 'odoo.getTicket',
    params: TicketId,
    handler: async (params, { runtime }) => runtime.odooGetTicket(params.id, params.instanceId)
  }),
  defineMethod({
    name: 'odoo.createTicket',
    params: CreateTicket,
    handler: async (params, { runtime }) =>
      runtime.odooCreateTicket({
        instanceId: params.instanceId,
        projectId: params.projectId,
        title: params.title.trim(),
        description: params.description?.trim() || undefined,
        priority: params.priority,
        stageId: params.stageId,
        assigneeIds: params.assigneeIds
      })
  }),
  defineMethod({
    name: 'odoo.updateTicket',
    params: UpdateTicket,
    handler: async (params, { runtime }) =>
      runtime.odooUpdateTicket(params.id, params.updates, params.instanceId)
  }),
  defineMethod({
    name: 'odoo.addTicketComment',
    params: TicketComment,
    handler: async (params, { runtime }) =>
      runtime.odooAddTicketComment(
        params.id,
        params.body.trim(),
        params.isNote,
        params.instanceId,
        params.mentionPartnerIds,
        params.attachmentIds
      )
  }),
  defineMethod({
    name: 'odoo.updateTicketComment',
    params: UpdateTicketComment,
    handler: async (params, { runtime }) =>
      runtime.odooUpdateTicketComment(params.id, params.body.trim(), params.instanceId)
  }),
  defineMethod({
    name: 'odoo.ticketComments',
    params: TicketId,
    handler: async (params, { runtime }) => runtime.odooTicketComments(params.id, params.instanceId)
  }),
  defineMethod({
    name: 'odoo.searchMentionCandidates',
    params: SearchMentionCandidates,
    handler: async (params, { runtime }) =>
      runtime.odooSearchMentionCandidates(
        params.ticketId,
        params.query?.trim() ?? '',
        params.instanceId
      )
  }),
  defineMethod({
    name: 'odoo.uploadTicketAttachments',
    params: UploadTicketAttachments,
    handler: async (params, { runtime }) =>
      runtime.odooUploadTicketAttachments(params.ticketId, params.files, params.instanceId)
  }),
  defineMethod({
    name: 'odoo.listProjects',
    params: InstanceSelection,
    handler: async (params, { runtime }) => runtime.odooListProjects(params?.instanceId)
  }),
  defineMethod({
    name: 'odoo.listStages',
    params: ProjectStages,
    handler: async (params, { runtime }) =>
      runtime.odooListStages(params.projectId, params.instanceId)
  }),
  defineMethod({
    name: 'odoo.listTags',
    params: InstanceSelection,
    handler: async (params, { runtime }) => runtime.odooListTags(params?.instanceId)
  }),
  defineMethod({
    name: 'odoo.listStageNames',
    params: InstanceSelection,
    handler: async (params, { runtime }) => runtime.odooListStageNames(params?.instanceId)
  }),
  defineMethod({
    name: 'odoo.listAssignableUsers',
    params: AssignableUsers,
    handler: async (params, { runtime }) =>
      runtime.odooListAssignableUsers(params.query, params.instanceId)
  })
]
