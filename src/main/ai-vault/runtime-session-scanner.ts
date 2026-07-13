import { z } from 'zod'
import {
  AI_VAULT_AGENTS,
  AI_VAULT_SCOPE_PATHS_MAX_COUNT,
  type AiVaultListArgs,
  type AiVaultListResult,
  type AiVaultSession
} from '../../shared/ai-vault-types'
import { normalizeExecutionHostId, toRuntimeExecutionHostId } from '../../shared/execution-host'
import { listEnvironments } from '../../shared/runtime-environment-store'
import { callRuntimeEnvironment } from '../ipc/runtime-environment-transport-routing'

export type RuntimeAiVaultHostInfo = {
  environmentId: string
  executionHostId: `runtime:${string}`
}

export type RuntimeAiVaultScanOptions = {
  timeoutMs?: number
}

const nodePlatformSchema = z.enum([
  'aix',
  'android',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'openbsd',
  'sunos',
  'win32',
  'cygwin',
  'netbsd'
] satisfies NodeJS.Platform[])

const aiVaultSessionPreviewMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool', 'unknown']),
  text: z.string(),
  timestamp: z.string().nullable()
})

const executionHostIdSchema = z.string().transform((value, ctx) => {
  const normalized = normalizeExecutionHostId(value)
  if (normalized) {
    return normalized
  }
  ctx.addIssue({
    code: 'custom',
    message: 'Invalid execution host id'
  })
  return z.NEVER
})

const aiVaultListResultSchema = z.object({
  sessions: z.array(
    z.object({
      id: z.string(),
      executionHostId: executionHostIdSchema,
      executionHostPlatform: nodePlatformSchema.nullable().optional(),
      agent: z.enum(AI_VAULT_AGENTS),
      sessionId: z.string(),
      title: z.string(),
      cwd: z.string().nullable(),
      branch: z.string().nullable(),
      model: z.string().nullable(),
      filePath: z.string(),
      codexHome: z.string().nullable(),
      createdAt: z.string().nullable(),
      updatedAt: z.string().nullable(),
      modifiedAt: z.string(),
      messageCount: z.number(),
      totalTokens: z.number(),
      previewMessages: z.array(aiVaultSessionPreviewMessageSchema),
      // Default keeps remote hosts running an older build (no recoverable-signal
      // fields) parseable; they simply report no recoverable-empty sessions.
      queuedMessageCount: z.number().default(0),
      subagentTranscriptCount: z.number().default(0),
      resumeCommand: z.string(),
      // The default keeps remote hosts running an older build (no subagent
      // field) parseable; scanned top-level sessions carry null anyway.
      subagent: z
        .object({
          parentSessionId: z.string(),
          agentType: z.string().nullable(),
          status: z.enum(['running', 'completed', 'failed', 'stopped']).nullable()
        })
        .nullable()
        .default(null)
    })
  ),
  issues: z.array(
    z.object({
      executionHostId: executionHostIdSchema.optional(),
      agent: z.enum(AI_VAULT_AGENTS),
      path: z.string(),
      message: z.string()
    })
  ),
  scannedAt: z.string()
})

export function getSavedRuntimeAiVaultHostInfos(
  userDataPath: string
): readonly RuntimeAiVaultHostInfo[] {
  return listEnvironments(userDataPath).map((environment) => ({
    environmentId: environment.id,
    executionHostId: toRuntimeExecutionHostId(environment.id)
  }))
}

export async function scanRuntimeAiVaultSessions(
  userDataPath: string,
  environmentId: string,
  args: AiVaultListArgs,
  options: RuntimeAiVaultScanOptions = {}
): Promise<AiVaultListResult> {
  const executionHostId = toRuntimeExecutionHostId(environmentId)
  const response = await callRuntimeEnvironment(
    userDataPath,
    environmentId,
    'aiVault.listSessions',
    {
      limit: args.limit,
      force: args.force,
      // Why: cap here so the set of scanned paths is explicit on this side —
      // the RPC schema CLAMPS to the same bound anyway (older hosts had no
      // cap). Dropped paths only lose the older-than-recency-cap guarantee,
      // never the recent sessions themselves.
      scopePaths: args.scopePaths?.slice(0, AI_VAULT_SCOPE_PATHS_MAX_COUNT),
      executionHostId
    },
    options.timeoutMs
  )
  if (response.ok === true) {
    const parsed = aiVaultListResultSchema.safeParse(response.result)
    if (parsed.success) {
      return withRuntimeExecutionHost(parsed.data, executionHostId)
    }
    return runtimeScanIssueResult({
      executionHostId,
      environmentId,
      message: `Invalid aiVault.listSessions response: ${
        parsed.error.issues[0]?.message ?? 'unexpected result shape'
      }`
    })
  }
  return runtimeScanIssueResult({
    executionHostId,
    environmentId,
    message: response.error.message
  })
}

function withRuntimeExecutionHost(
  result: AiVaultListResult,
  executionHostId: `runtime:${string}`
): AiVaultListResult {
  return {
    sessions: result.sessions.map((session) => retagRuntimeSession(session, executionHostId)),
    issues: result.issues.map((issue) => ({ ...issue, executionHostId })),
    scannedAt: result.scannedAt
  }
}

function retagRuntimeSession(
  session: AiVaultSession,
  executionHostId: `runtime:${string}`
): AiVaultSession {
  // The paired server is the transport, but the parent owns which concrete
  // runtime host was scanned; never trust returned host ids across the boundary.
  return {
    ...session,
    executionHostId,
    id: `${executionHostId}:${session.agent}:${session.sessionId}:${session.filePath}`
  }
}

function runtimeScanIssueResult(args: {
  executionHostId: `runtime:${string}`
  environmentId: string
  message: string
}): AiVaultListResult {
  return {
    sessions: [],
    issues: [
      {
        executionHostId: args.executionHostId,
        agent: 'codex',
        path: args.environmentId,
        message: args.message
      }
    ],
    scannedAt: new Date().toISOString()
  }
}
