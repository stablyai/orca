import { z } from 'zod'
import {
  AI_VAULT_SCOPE_PATHS_MAX_COUNT,
  type AiVaultListArgs,
  type AiVaultListResult,
  type AiVaultSession
} from '../../shared/ai-vault-types'
import { toRuntimeExecutionHostId } from '../../shared/execution-host'
import { listEnvironments } from '../../shared/runtime-environment-store'
import { callRuntimeEnvironment } from '../ipc/runtime-environment-transport-routing'
import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../../shared/ai-vault-resume-preparation'
import { parseAiVaultListResult } from './session-list-result-validation'

export type RuntimeAiVaultHostInfo = {
  environmentId: string
  executionHostId: `runtime:${string}`
}

export type RuntimeAiVaultScanOptions = {
  timeoutMs?: number
}

// Why: zod strips unknown keys, so the repin home must be declared or the
// parent would silently drop it and resume under the wrong account's home.
const aiVaultPrepareSessionResumeResultSchema = z.object({
  useRealCodexHome: z.boolean(),
  substituteCodexHome: z.string().optional()
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
      unlimited: args.unlimited,
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
    try {
      const result = withRuntimeExecutionHost(
        parseAiVaultListResult(response.result),
        executionHostId
      )
      if (!args.scopePaths || args.scopePaths.length <= AI_VAULT_SCOPE_PATHS_MAX_COUNT) {
        return result
      }
      return {
        ...result,
        issues: [
          ...result.issues,
          {
            executionHostId,
            agent: 'codex',
            kind: 'scope',
            path: environmentId,
            message: `Only the first ${AI_VAULT_SCOPE_PATHS_MAX_COUNT} project paths were scanned.`
          }
        ]
      }
    } catch (error) {
      return runtimeScanIssueResult({
        executionHostId,
        environmentId,
        message: `Invalid aiVault.listSessions response: ${
          error instanceof Error ? error.message : 'unexpected result shape'
        }`
      })
    }
  }
  return runtimeScanIssueResult({
    executionHostId,
    environmentId,
    message: response.error.message
  })
}

export async function prepareRuntimeAiVaultSessionResume(
  userDataPath: string,
  environmentId: string,
  args: AiVaultPrepareSessionResumeArgs
): Promise<AiVaultPrepareSessionResumeResult> {
  const response = await callRuntimeEnvironment(
    userDataPath,
    environmentId,
    'aiVault.prepareSessionResume',
    args
  )
  if (response.ok !== true) {
    throw new Error(response.error.message)
  }
  const parsed = aiVaultPrepareSessionResumeResultSchema.safeParse(response.result)
  if (!parsed.success) {
    throw new Error(
      `Invalid aiVault.prepareSessionResume response: ${parsed.error.issues[0]?.message ?? 'unexpected result shape'}`
    )
  }
  return parsed.data
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
        kind: 'host',
        path: args.environmentId,
        message: args.message
      }
    ],
    scannedAt: new Date().toISOString()
  }
}
