import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalBoolean } from '../schemas'
import { restampAiVaultListResult } from '../../../ai-vault/session-list-results'
import { AI_VAULT_AGENTS, AI_VAULT_SCOPE_PATHS_MAX_COUNT } from '../../../../shared/ai-vault-types'
import { AI_VAULT_SESSION_TITLE_REQUEST_MAX_COUNT } from '../../../../shared/ai-vault-session-title'
import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../../../shared/execution-host'
import { describeAiVaultScanError } from '../../../../shared/ai-vault-scan-error-message'

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

export const AiVaultListSessionsParams = z
  .object({
    limit: z
      .unknown()
      .transform((value) =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
      )
      .pipe(z.union([z.number().int(), z.undefined()]))
      .optional(),
    unlimited: OptionalBoolean,
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
  .superRefine((params, ctx) => {
    if (params.unlimited !== true && params.limit && params.limit > AI_VAULT_LIMIT_MAX) {
      ctx.addIssue({ code: 'custom', path: ['limit'], message: 'Limit exceeds maximum' })
    }
  })

export const AiVaultPrepareSessionResumeParams = z.object({
  agent: z.enum(AI_VAULT_AGENTS),
  filePath: z.string().min(1).max(AI_VAULT_SCOPE_PATH_MAX_LENGTH),
  codexHome: z.string().min(1).max(AI_VAULT_SCOPE_PATH_MAX_LENGTH).nullable(),
  executionHostId: z.string().optional()
})

export const AiVaultSessionTitlesParams = z.object({
  requests: z
    .array(
      z.object({
        agent: z.enum(['claude', 'codex']),
        sessionId: z.string().min(1).max(512),
        transcriptPath: z.string().min(1).max(32_768).optional()
      })
    )
    .max(AI_VAULT_SESSION_TITLE_REQUEST_MAX_COUNT)
})

export const AI_VAULT_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'aiVault.resolveSessionTitles',
    params: AiVaultSessionTitlesParams,
    handler: (params, { runtime, signal }) =>
      runtime.resolveAiVaultSessionTitles(params.requests, signal)
  }),
  defineMethod({
    name: 'aiVault.listSessions',
    params: AiVaultListSessionsParams,
    handler: async (params, { runtime }) => {
      let result
      try {
        result = await runtime.listAiVaultSessions({
          limit: params.unlimited ? undefined : params.limit,
          unlimited: params.unlimited,
          force: params.force,
          scopePaths: params.scopePaths
        })
      } catch (error) {
        if (error instanceof Error) {
          error.message = describeAiVaultScanError(error.message)
          throw error
        }
        throw new Error(describeAiVaultScanError(String(error)))
      }
      // Why: web clients consume this response directly (no parent-side retag),
      // so sessions must come back stamped as the runtime host they addressed.
      return params.executionHostId
        ? restampAiVaultListResult(result, params.executionHostId)
        : result
    }
  }),
  defineMethod({
    name: 'aiVault.prepareSessionResume',
    params: AiVaultPrepareSessionResumeParams,
    handler: (params, { runtime }) =>
      runtime.prepareAiVaultSessionResume({
        agent: params.agent,
        filePath: params.filePath,
        codexHome: params.codexHome,
        // Why: the RPC executes on the transcript-owning host; never let a
        // client-provided runtime/SSH stamp escape that host boundary.
        executionHostId: LOCAL_EXECUTION_HOST_ID
      })
  })
]
