import { z } from 'zod'
import {
  SESSION_SEARCH_METHODS,
  SessionSearchConfigureSchema,
  SessionSearchQuerySchema
} from '../../../../shared/ai-vault-search-contract'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalBoolean } from '../schemas'
import { restampAiVaultListResult } from '../../../ai-vault/session-list-results'
import { AI_VAULT_AGENTS, AI_VAULT_SCOPE_PATHS_MAX_COUNT } from '../../../../shared/ai-vault-types'
import { AI_VAULT_SESSION_TITLE_REQUEST_MAX_COUNT } from '../../../../shared/ai-vault-session-title'
import type { AiVaultPrepareSessionResumeArgs } from '../../../../shared/ai-vault-resume-preparation'
import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../../../shared/execution-host'
import { describeAiVaultScanError } from '../../../../shared/ai-vault-scan-error-message'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import {
  assertLegacyAiVaultResumeAllowed,
  projectStructuredAiVaultSessions
} from '../../../ai-vault/structured-session-ownership'

// Why: bound limit + scopePaths so a client cannot force an unbounded scan.
// Each scopePath is a host-local match prefix (validated/capped, never used for
// traversal); the count/length caps mirror the worktree-schemas bounding style.
const AI_VAULT_SCOPE_PATH_MAX_LENGTH = 4096
const AI_VAULT_LIMIT_MAX = 2000

// Why: this is the whole SSH/foreign-host boundary for the aiVault surface. The
// scan and the index are host-local, so a caller must not be able to name a host
// this process does not execute on — an `ssh:` or `local` id is refused here
// rather than silently answered with this runtime's own transcripts
// (docs/reference/ssh-execution-boundary.md rule 1). A `runtime:` id names the
// *client's* saved environment, whose id this host never learns, so it is
// accepted for restamping only and never routes anything.
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
  sessionId: z.string().min(1).max(512).optional(),
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

export const AiVaultSearchSessionsParams = SessionSearchQuerySchema.extend({
  // Preserve local RPC coercion and truncation for existing clients.
  scopePaths: z
    .array(z.string().min(1).max(AI_VAULT_SCOPE_PATH_MAX_LENGTH))
    .transform((paths) => paths.slice(0, AI_VAULT_SCOPE_PATHS_MAX_COUNT))
    .optional(),
  refresh: OptionalBoolean,
  executionHostId: executionHostIdSchema.optional()
})

export const AiVaultConfigureSessionSearchParams = SessionSearchConfigureSchema.extend({
  enabled: OptionalBoolean,
  clearIndex: OptionalBoolean,
  executionHostId: executionHostIdSchema.optional()
})

export const AI_VAULT_METHODS: RpcMethod[] = [
  defineMethod({
    name: SESSION_SEARCH_METHODS.query.runtimeSsh,
    params: SessionSearchQuerySchema.extend({ targetId: z.string().min(1).max(512) }),
    handler: ({ targetId, ...params }, { runtime, signal }) =>
      runtime.sshSearchAiVault(targetId, 'query', params, signal)
  }),
  defineMethod({
    name: SESSION_SEARCH_METHODS.status.runtimeSsh,
    params: z.object({ targetId: z.string().min(1).max(512) }),
    handler: ({ targetId }, { runtime, signal }) =>
      runtime.sshSearchAiVault(targetId, 'status', {}, signal)
  }),
  defineMethod({
    name: SESSION_SEARCH_METHODS.configure.runtimeSsh,
    params: SessionSearchConfigureSchema.extend({ targetId: z.string().min(1).max(512) }),
    handler: ({ targetId, ...params }, { runtime, signal }) =>
      runtime.sshSearchAiVault(targetId, 'configure', params, signal)
  }),
  defineMethod({
    name: SESSION_SEARCH_METHODS.query.runtime,
    params: AiVaultSearchSessionsParams,
    // Why: the index lives with the transcripts, so this runs on the host the
    // client addressed; the id only names that host, it never redirects the search.
    handler: ({ executionHostId: _host, ...params }, { runtime, signal }) =>
      runtime.searchAiVaultSessions(params, signal)
  }),
  defineMethod({
    name: SESSION_SEARCH_METHODS.coverage.runtime,
    params: z.object({ executionHostId: executionHostIdSchema.optional() }),
    handler: (_params, { runtime, signal }) => runtime.readAiVaultSearchCoverage(signal)
  }),
  defineMethod({
    name: SESSION_SEARCH_METHODS.status.runtime,
    params: z.object({ executionHostId: executionHostIdSchema.optional() }),
    handler: (_params, { runtime }) => runtime.readAiVaultSearchIndexStatus()
  }),
  defineMethod({
    name: SESSION_SEARCH_METHODS.configure.runtime,
    params: AiVaultConfigureSessionSearchParams,
    // Why: consent is per machine and the index lives with the transcripts, so
    // this writes the addressed host's own setting; the id never redirects it.
    handler: ({ executionHostId: _host, ...params }, { runtime }) =>
      runtime.configureAiVaultSessionSearch(params)
  }),
  defineMethod({
    name: 'aiVault.resolveSessionTitles',
    params: AiVaultSessionTitlesParams,
    handler: (params, { runtime, signal }) =>
      runtime.resolveAiVaultSessionTitles(params.requests, signal)
  }),
  defineMethod({
    name: 'aiVault.listSessions',
    params: AiVaultListSessionsParams,
    handler: async (params, { runtime, clientKind, clientCapabilities }) => {
      await runtime.ensureStructuredAgentSessionHost()
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
      const stamped = params.executionHostId
        ? restampAiVaultListResult(result, params.executionHostId)
        : result
      return projectStructuredAiVaultSessions(
        stamped,
        clientKind === undefined ||
          (clientCapabilities?.includes(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY) ?? false)
      )
    }
  }),
  defineMethod({
    name: 'aiVault.prepareSessionResume',
    params: AiVaultPrepareSessionResumeParams,
    handler: async (params, { runtime }) => {
      const args: AiVaultPrepareSessionResumeArgs = {
        agent: params.agent,
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        filePath: params.filePath,
        codexHome: params.codexHome,
        // Why: the RPC executes on the transcript-owning host; never let a
        // client-provided runtime/SSH stamp escape that host boundary.
        executionHostId: LOCAL_EXECUTION_HOST_ID
      }
      await runtime.ensureStructuredAgentSessionHost()
      assertLegacyAiVaultResumeAllowed(args)
      return runtime.prepareAiVaultSessionResume(args)
    }
  })
]
