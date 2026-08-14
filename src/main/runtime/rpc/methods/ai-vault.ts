import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalBoolean } from '../schemas'
import {
  aiVaultScanIssueResult,
  mergeAiVaultListResults,
  restampAiVaultListResult
} from '../../../ai-vault/session-list-results'
import { parseAiVaultSessionTitlesResult } from '../../../ai-vault/session-title-result-validation'
import { scanSshAiVaultSessions } from '../../../ai-vault/ssh-session-list'
import {
  getActiveSshAiVaultHostInfos,
  requestActiveSshAiVaultSessionTitles
} from '../../../ipc/ssh'
import { scanHostLegWithCache } from '../../../ipc/ai-vault-host-leg-cache'
import { requestedAiVaultSessionDepth } from '../../../../shared/ai-vault-session-depth'
import {
  AI_VAULT_AGENTS,
  AI_VAULT_SCOPE_PATHS_MAX_COUNT,
  type AiVaultListArgs,
  type AiVaultListResult
} from '../../../../shared/ai-vault-types'
import { AI_VAULT_SESSION_TITLE_REQUEST_MAX_COUNT } from '../../../../shared/ai-vault-session-title'
import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../../../shared/execution-host'

// Why: bound limit + scopePaths so a client cannot force an unbounded scan.
// Each scopePath is a host-local match prefix (validated/capped, never used for
// traversal); the count/length caps mirror the worktree-schemas bounding style.
const AI_VAULT_SCOPE_PATH_MAX_LENGTH = 4096
const AI_VAULT_LIMIT_MAX = 2000
// Keep in lockstep with desktop all-hosts SSH legs so a stuck relay cannot hang
// web/mobile includeOwnedSshHosts scans or a named ssh: hop.
const OWNED_SSH_SCAN_TIMEOUT_MS = 20_000

const executionHostIdSchema = z
  .string()
  .transform((value, ctx): `runtime:${string}` | `ssh:${string}` => {
    const parsed = parseExecutionHostId(value)
    if (parsed?.kind === 'runtime' || parsed?.kind === 'ssh') {
      return parsed.id
    }
    ctx.addIssue({
      code: 'custom',
      message: 'Invalid execution host id'
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
    // Why: desktop/web callers name the runtime host they are addressing; a
    // paired client can also name an SSH host this runtime owns. Runtime ids
    // still only restamp the host-local cache. SSH ids route to that host.
    executionHostId: executionHostIdSchema.optional(),
    // Why: omitted on old clients so mixed-version peers keep the host-local
    // projection. New all-hosts callers opt in to this runtime's SSH inventory.
    includeOwnedSshHosts: OptionalBoolean
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
    .max(AI_VAULT_SESSION_TITLE_REQUEST_MAX_COUNT),
  executionHostId: executionHostIdSchema.optional()
})

export const AI_VAULT_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'aiVault.resolveSessionTitles',
    params: AiVaultSessionTitlesParams,
    handler: async (params, { runtime, signal }) => {
      const parsed = params.executionHostId ? parseExecutionHostId(params.executionHostId) : null
      if (parsed?.kind === 'ssh') {
        try {
          const result = await requestActiveSshAiVaultSessionTitles(
            parsed.targetId,
            { requests: params.requests },
            { signal }
          )
          return result === null ? { titles: [] } : parseAiVaultSessionTitlesResult(result)
        } catch {
          return { titles: [] }
        }
      }
      return runtime.resolveAiVaultSessionTitles(params.requests, signal)
    }
  }),
  defineMethod({
    name: 'aiVault.listSessions',
    params: AiVaultListSessionsParams,
    handler: async (params, { runtime, signal }) => {
      const parsed = params.executionHostId ? parseExecutionHostId(params.executionHostId) : null
      const listArgs = {
        limit: params.unlimited ? undefined : params.limit,
        unlimited: params.unlimited,
        force: params.force,
        scopePaths: params.scopePaths
      }
      if (parsed?.kind === 'ssh') {
        return scanRuntimeSshAiVaultSessions(parsed.targetId, listArgs, signal)
      }
      const sshHosts = params.includeOwnedSshHosts === true ? getActiveSshAiVaultHostInfos() : []
      const sshPromise =
        sshHosts.length > 0
          ? Promise.all(
              sshHosts.map((host) => scanRuntimeSshAiVaultSessions(host.targetId, listArgs, signal))
            )
          : Promise.resolve([])
      const localPromise = runtime.listAiVaultSessions(listArgs).catch((error: unknown) => {
        if (params.includeOwnedSshHosts !== true) {
          throw error
        }
        return aiVaultScanIssueResult({
          executionHostId: LOCAL_EXECUTION_HOST_ID,
          path: 'this computer',
          message: error instanceof Error ? error.message : 'Local session scan failed.'
        })
      })
      const [result, sshResults] = await Promise.all([localPromise, sshPromise])
      // Why: web clients consume this response directly (no parent-side retag),
      // so host-local sessions must come back stamped as the runtime they addressed.
      const stamped =
        parsed?.kind === 'runtime' ? restampAiVaultListResult(result, parsed.id) : result
      if (sshResults.length === 0) {
        return stamped
      }
      return mergeAiVaultListResults([stamped, ...sshResults], listArgs.limit, listArgs.unlimited)
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

function scanRuntimeSshAiVaultSessions(
  targetId: string,
  args: AiVaultListArgs,
  signal?: AbortSignal
): Promise<AiVaultListResult> {
  const scopePaths = args.scopePaths ?? []
  return scanHostLegWithCache({
    cacheKey: JSON.stringify({
      route: 'runtime-rpc-ssh',
      targetId,
      scopePaths: [...new Set(scopePaths)].sort()
    }),
    depth: requestedAiVaultSessionDepth(args),
    scopePaths,
    force: args.force === true,
    scan: () =>
      scanSshAiVaultSessions(targetId, args, {
        ...(signal ? { signal } : {}),
        timeoutMs: OWNED_SSH_SCAN_TIMEOUT_MS
      })
  })
}
