import { z } from 'zod'
import { scanAiVaultSessions } from '../../../ai-vault/session-scanner'
import { defineMethod, type RpcMethod } from '../core'
import { normalizeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'

const executionHostIdSchema = z
  .string()
  .refine((value) => normalizeExecutionHostId(value) !== null, {
    message: 'Invalid execution host id'
  })
  .transform((value) => normalizeExecutionHostId(value) as ExecutionHostId)

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
