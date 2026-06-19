import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalPlainString, OptionalString, requiredNumber, requiredString } from '../schemas'

const VALID_FILTERS = ['assigned', 'created', 'all', 'closed'] as const

const VALID_STATUSES = ['new', 'assigned', 'planned', 'pending', 'solved', 'closed'] as const

const ServerSelection = z
  .object({
    serverId: OptionalString
  })
  .optional()

const SelectServer = z.object({
  serverId: requiredString('Server ID is required')
})

const Connect = z.object({
  baseUrl: requiredString('Base URL is required'),
  appToken: requiredString('App token is required'),
  userToken: requiredString('User token is required')
})

const ListWorkItems = z
  .object({
    serverId: OptionalString,
    filter: z.enum(VALID_FILTERS).optional().default('all'),
    limit: z.number().int().min(1).max(100).optional().default(30),
    filters: z
      .object({
        type: z.enum(['incident', 'request']).optional(),
        text: z.string().optional(),
        category: z.string().optional(),
        priority: z.number().int().min(1).max(5).optional()
      })
      .optional()
  })
  .optional()

const TicketId = z.object({
  serverId: OptionalString,
  id: requiredNumber('Ticket ID is required')
})

const AddFollowup = z.object({
  serverId: OptionalString,
  id: requiredNumber('Ticket ID is required'),
  content: requiredString('Content is required')
})

const UpdateTicket = z.object({
  serverId: OptionalString,
  id: requiredNumber('Ticket ID is required'),
  updates: z.object({
    title: OptionalString,
    content: OptionalString,
    status: z.enum(VALID_STATUSES).optional()
  })
})

const CreateTicket = z.object({
  serverId: OptionalString,
  title: requiredString('Title is required'),
  content: OptionalPlainString,
  type: z.enum(['incident', 'request']).optional(),
  urgency: z.number().int().min(1).max(5).optional()
})

export const GLPI_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'glpi.status',
    params: null,
    handler: async (_params, { runtime }) => runtime.glpiStatus()
  }),
  defineMethod({
    name: 'glpi.connect',
    params: Connect,
    handler: async (params, { runtime }) =>
      runtime.glpiConnect({
        baseUrl: params.baseUrl.trim(),
        appToken: params.appToken.trim(),
        userToken: params.userToken.trim()
      })
  }),
  defineMethod({
    name: 'glpi.disconnect',
    params: ServerSelection,
    handler: async (params, { runtime }) => runtime.glpiDisconnect(params?.serverId)
  }),
  defineMethod({
    name: 'glpi.selectServer',
    params: SelectServer,
    handler: async (params, { runtime }) => runtime.glpiSelectServer(params.serverId.trim())
  }),
  defineMethod({
    name: 'glpi.testConnection',
    params: ServerSelection,
    handler: async (params, { runtime }) => runtime.glpiTestConnection(params?.serverId)
  }),
  defineMethod({
    name: 'glpi.listWorkItems',
    params: ListWorkItems,
    handler: async (params, { runtime }) =>
      runtime.glpiListWorkItems(
        params?.serverId ?? null,
        params?.filter ?? 'all',
        params?.limit ?? 30,
        params?.filters
      )
  }),
  defineMethod({
    name: 'glpi.ticket',
    params: TicketId,
    handler: async (params, { runtime }) => runtime.glpiTicket(params.serverId ?? null, params.id)
  }),
  defineMethod({
    name: 'glpi.followups',
    params: TicketId,
    handler: async (params, { runtime }) =>
      runtime.glpiFollowups(params.serverId ?? null, params.id)
  }),
  defineMethod({
    name: 'glpi.addFollowup',
    params: AddFollowup,
    handler: async (params, { runtime }) =>
      runtime.glpiAddFollowup(params.serverId ?? null, params.id, params.content.trim())
  }),
  defineMethod({
    name: 'glpi.updateTicket',
    params: UpdateTicket,
    handler: async (params, { runtime }) =>
      runtime.glpiUpdateTicket(params.serverId ?? null, params.id, params.updates)
  }),
  defineMethod({
    name: 'glpi.createTicket',
    params: CreateTicket,
    handler: async (params, { runtime }) =>
      runtime.glpiCreateTicket({
        serverId: params.serverId,
        title: params.title.trim(),
        content: params.content?.trim() || undefined,
        type: params.type,
        urgency: params.urgency
      })
  })
]
