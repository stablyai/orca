import { AiVaultChatForkSourceSchema } from '../../shared/ai-vault-chat-fork-contract'
import { z } from 'zod'
import {
  AI_VAULT_AGENTS,
  AI_VAULT_SCOPE_PATHS_MAX_COUNT,
  type AiVaultListArgs,
  type AiVaultListResult,
  type AiVaultSession
} from '../../shared/ai-vault-types'
import { toRuntimeExecutionHostId } from '../../shared/execution-host'
import { listEnvironments, resolveEnvironment } from '../../shared/runtime-environment-store'
import { callRuntimeEnvironment } from '../ipc/runtime-environments/runtime-environment-transport-routing'
import type {
  AiVaultPrepareSessionResumeRequest,
  AiVaultPrepareSessionResumeResult
} from '../../shared/ai-vault-resume-preparation'
import type {
  AiVaultSessionTitlesArgs,
  AiVaultSessionTitlesResult
} from '../../shared/ai-vault-session-title'
import { parseAiVaultListResult } from './session-list-result-validation'
import { parseAiVaultSessionTitlesResult } from './session-title-result-validation'
import { isGatedOffWslHost } from '../wsl/wsl-host-gate'
import type {
  AiVaultDeleteSessionArgs,
  AiVaultDeleteSessionResult
} from '../../shared/ai-vault-session-deletion'
import {
  readRuntimeAiVaultDeleteSessionResponse,
  runtimeAiVaultDeleteSessionParams
} from '../../shared/ai-vault-runtime-session-delete'
import type { RuntimeAiVaultHostInfo } from '../ipc/ai-vault-runtime-scan'

export type RuntimeAiVaultScanOptions = {
  timeoutMs?: number
}

// Zod strips undeclared keys; keep the repinned home so resume uses the correct account.
const aiVaultPrepareSessionResumeResultSchema = z.object({
  useRealCodexHome: z.boolean(),
  cliForkSource: AiVaultChatForkSourceSchema.optional(),
  substituteCodexHome: z.string().optional(),
  forkedSession: z
    .object({
      sessionId: z.string(),
      agent: z.enum(AI_VAULT_AGENTS),
      filePath: z.string().optional()
    })
    .optional()
})

export function getSavedRuntimeAiVaultHostInfos(
  userDataPath: string
): readonly RuntimeAiVaultHostInfo[] {
  return listEnvironments(userDataPath)
    .filter((environment) => !isGatedOffWslHost(environment))
    .map((environment) => ({
      environmentId: environment.id,
      executionHostId: toRuntimeExecutionHostId(environment.id),
      ...(environment.connectionDependency
        ? { connectionDependency: environment.connectionDependency }
        : {})
    }))
}

export async function scanRuntimeAiVaultSessions(
  userDataPath: string,
  environmentId: string,
  args: AiVaultListArgs,
  options: RuntimeAiVaultScanOptions = {}
): Promise<AiVaultListResult> {
  const executionHostId = toRuntimeExecutionHostId(environmentId)
  // Captured before the call: a re-pair mid-scan leaves rows fenced to the older pairing, never the newer.
  const pairingRevision = savedPairingRevision(userDataPath, environmentId)
  const response = await callRuntimeEnvironment(
    userDataPath,
    environmentId,
    'aiVault.listSessions',
    {
      includeAntigravityIdeSessions: args.includeAntigravityIdeSessions,
      limit: args.limit,
      unlimited: args.unlimited,
      force: args.force,
      ...(args.afterFingerprint !== undefined ? { afterFingerprint: args.afterFingerprint } : {}),
      // Cap paths for older hosts too; omitted scope paths lose deep-history coverage, not recent sessions.
      scopePaths: args.scopePaths?.slice(0, AI_VAULT_SCOPE_PATHS_MAX_COUNT),
      executionHostId
    },
    options.timeoutMs
  )
  if (response.ok === true) {
    try {
      const parsed = parseAiVaultListResult(response.result)
      if (parsed.unchanged) {
        if (parsed.fingerprint !== args.afterFingerprint) {
          throw new Error('Unchanged response did not match the requested fingerprint')
        }
        return parsed
      }
      const result = withRuntimeExecutionHost(parsed, executionHostId, pairingRevision)
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

export async function resolveRuntimeAiVaultSessionTitles(
  userDataPath: string,
  environmentId: string,
  args: AiVaultSessionTitlesArgs
): Promise<AiVaultSessionTitlesResult> {
  const response = await callRuntimeEnvironment(
    userDataPath,
    environmentId,
    'aiVault.resolveSessionTitles',
    { requests: args.requests }
  )
  if (response.ok !== true) {
    return { titles: [] }
  }
  try {
    return parseAiVaultSessionTitlesResult(response.result)
  } catch {
    return { titles: [] }
  }
}

export async function prepareRuntimeAiVaultSessionResume(
  userDataPath: string,
  environmentId: string,
  args: AiVaultPrepareSessionResumeRequest
): Promise<AiVaultPrepareSessionResumeResult> {
  const response = await callRuntimeEnvironment(
    userDataPath,
    environmentId,
    'aiVault.prepareSessionResume',
    args
  )
  if (response.ok !== true) {
    if (
      response.error.code === 'method_not_found' &&
      response.error.message === 'Unknown method: aiVault.prepareSessionResume'
    ) {
      // Electron drops custom error fields; preserve this compatibility verdict in the message.
      throw new Error('aiVault.prepareSessionResume: method_not_found')
    }
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

/** The owning host validates and deletes; a host without the RPC asks for an update instead. */
export async function deleteRuntimeAiVaultSession(
  userDataPath: string,
  environmentId: string,
  args: AiVaultDeleteSessionArgs
): Promise<AiVaultDeleteSessionResult> {
  const response = await callRuntimeEnvironment(
    userDataPath,
    environmentId,
    'aiVault.deleteSession',
    runtimeAiVaultDeleteSessionParams(args),
    undefined,
    args.expectedEnvironmentPairingRevision
  )
  return readRuntimeAiVaultDeleteSessionResponse(response, args.agent)
}

function savedPairingRevision(userDataPath: string, environmentId: string): number | undefined {
  try {
    const environment = resolveEnvironment(userDataPath, environmentId)
    return environment.pairingRevision ?? environment.createdAt
  } catch {
    return undefined
  }
}

function withRuntimeExecutionHost(
  result: AiVaultListResult,
  executionHostId: `runtime:${string}`,
  pairingRevision: number | undefined
): AiVaultListResult {
  return {
    sessions: result.sessions.map((session) =>
      retagRuntimeSession(session, executionHostId, pairingRevision)
    ),
    issues: result.issues.map((issue) => ({ ...issue, executionHostId })),
    scannedAt: result.scannedAt,
    ...(result.fingerprint ? { fingerprint: result.fingerprint } : {})
  }
}

function retagRuntimeSession(
  session: AiVaultSession,
  executionHostId: `runtime:${string}`,
  pairingRevision: number | undefined
): AiVaultSession {
  // The caller selects the scanned host; a transport peer cannot supply trusted execution IDs or pairings.
  const { hostPairingRevision: _untrusted, ...rest } = session
  return {
    ...rest,
    executionHostId,
    id: `${executionHostId}:${session.agent}:${session.sessionId}:${session.filePath}`,
    ...(pairingRevision !== undefined ? { hostPairingRevision: pairingRevision } : {})
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
