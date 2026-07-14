import { z } from 'zod'
import { DatabaseService } from '../../../database/database-service'
import { defineMethod, type RpcMethod } from '../core'

const service = new DatabaseService()

const DatabaseConnection = z.object({
  providerId: z.literal('postgres'),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65_535),
  database: z.string().trim().min(1).max(255),
  user: z.string().trim().min(1).max(255),
  sslMode: z.enum(['disable', 'require', 'verify-full'])
})

const DatabaseCredential = z.object({
  password: z.string().max(16_384).optional()
})

const DatabaseConnectionRequest = z.object({
  connection: DatabaseConnection,
  credential: DatabaseCredential
})

const DatabaseQueryRequest = DatabaseConnectionRequest.extend({
  queryId: z.string().min(1).max(128),
  sql: z
    .string()
    .trim()
    .min(1)
    .max(1024 * 1024),
  readOnly: z.boolean(),
  maxRows: z.number().int().min(1).max(10_000),
  timeoutMs: z.number().int().min(100).max(300_000)
})

const DatabaseCancelRequest = z.object({
  providerId: z.literal('postgres'),
  queryId: z.string().min(1).max(128)
})

export const DATABASE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'database.testConnection',
    params: DatabaseConnectionRequest,
    handler: (params, { signal }) => service.testConnection(params, signal)
  }),
  defineMethod({
    name: 'database.introspect',
    params: DatabaseConnectionRequest,
    handler: (params, { signal }) => service.introspect(params, signal)
  }),
  defineMethod({
    name: 'database.execute',
    params: DatabaseQueryRequest,
    handler: (params, { signal }) => service.execute(params, signal)
  }),
  defineMethod({
    name: 'database.cancel',
    params: DatabaseCancelRequest,
    handler: async (params) => ({
      canceled: await service.cancel(params.providerId, params.queryId)
    })
  })
]
