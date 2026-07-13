import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalBoolean } from '../schemas'
import { restampAiVaultListResult } from '../../../ai-vault/session-list-results'
import { AI_VAULT_SCOPE_PATHS_MAX_COUNT } from '../../../../shared/ai-vault-types'
import { parseExecutionHostId } from '../../../../shared/execution-host'

// Why: bound limit + scopePaths so a client cannot force an unbounded scan.
// Each scopePath is a host-local match prefix (validated/capped, never used for
// traversal); the count/length caps mirror the worktree-schemas bounding style.
const AI_VAULT_SCOPE_PATH_MAX_LENGTH = 4096
const AI_VAULT_LIMIT_MAX = 2000

const executionHostIdSchema = z.string().transform((value, ctx): `runtime:${string}` => {
  const parsed = parseExecutionHostId(value)
  if (parsed?.kind === 'runtime') {
    return parsed.id
  }
  ctx.addIssue({
    code: 'custom',
    message: 'Invalid runtime execution host id'
  })
  return z.NEVER
})

export const AiVaultListSessionsParams = z.object({
  limit: z
    .unknown()
    .transform((value) =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
    )
    .pipe(z.union([z.number().int().max(AI_VAULT_LIMIT_MAX), z.undefined()]))
    .optional(),
  force: OptionalBoolean,
  scopePaths: z
    .array(z.string().min(1).max(AI_VAULT_SCOPE_PATH_MAX_LENGTH))
    // Why: clamp instead of reject — scope paths only ever widen discovery, and
    // rejecting would hard-break older/uncapped producers (web client, pre-cap
    // desktop parents) that send more than the bound.
    .transform((paths) => paths.slice(0, AI_VAULT_SCOPE_PATHS_MAX_COUNT))
    .optional(),
  // Why: desktop/web callers name the runtime host they are addressing; mobile
  // omits it. The scan itself is host-local either way, so the id must never
  // change what is scanned — it only restamps the shared cached result.
  executionHostId: executionHostIdSchema.optional()
})

export const AI_VAULT_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'aiVault.listSessions',
    params: AiVaultListSessionsParams,
    handler: async (params, { runtime }) => {
      const result = await runtime.listAiVaultSessions({
        limit: params.limit,
        force: params.force,
        scopePaths: params.scopePaths
      })
      // Why: web clients consume this response directly (no parent-side retag),
      // so sessions must come back stamped as the runtime host they addressed.
      return params.executionHostId
        ? restampAiVaultListResult(result, params.executionHostId)
        : result
    }
  })
]
