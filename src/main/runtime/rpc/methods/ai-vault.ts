import { z } from 'zod'
import { scanAiVaultSessions } from '../../../ai-vault/session-scanner'
import { defineMethod, type RpcMethod } from '../core'
import { normalizeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'

const executionHostIdSchema = z
  .string()
  .transform((value) => normalizeExecutionHostId(value))
  .refine((value): value is ExecutionHostId => value !== null, {
    message: 'Invalid execution host id'
  })

const listSessionsParamsSchema = z.object({
  limit: z.number().int().positive().optional(),
  force: z.boolean().optional(),
  scopePaths: z.array(z.string()).optional(),
  executionHostId: executionHostIdSchema
})

export const AI_VAULT_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'aiVault.listSessions',
    params: listSessionsParamsSchema,
    handler: async (params) =>
      scanAiVaultSessions({
        limit: params.limit,
        scopePaths: params.scopePaths,
        executionHostId: params.executionHostId
      })
  })
]
