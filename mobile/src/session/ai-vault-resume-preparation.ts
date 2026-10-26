import type { TuiAgent } from '../../../src/shared/tui-agent'
import { createAgentTerminalResumeAttemptRegistry } from '../../../src/shared/agent-terminal-resume-attempt'
import type { MobileAiVaultResumeLaunch } from './ai-vault-resume-launch'
import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import {
  isAiVaultPrepareSessionResumeUnavailableError,
  isLegacySharedCodexHome,
  isPerAccountManagedCodexHome
} from '../../../src/shared/ai-vault-resume-preparation'
import { LOCAL_EXECUTION_HOST_ID } from '../../../src/shared/execution-host'
import { aiVaultResumePreparationRun } from './mobile-session-launch-operations'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'

// Why: without an explicit timeout, a socket drop mid-resume parks the request
// on the reconnect waiter for the full reconnect budget, pinning the spinner.
export const RESUME_RPC_TIMEOUT_MS = 30_000

export async function prepareMobileAiVaultSessionResume(
  client: RpcOperationSender,
  session: AiVaultSession
): Promise<AiVaultSession> {
  // Why: per-account repinning runs on the serving host, whose account
  // selection only applies to that host's own ("local") sessions.
  const needsAccountRepin =
    isPerAccountManagedCodexHome(session.codexHome) &&
    (!session.executionHostId || session.executionHostId === LOCAL_EXECUTION_HOST_ID)
  if (
    session.agent !== 'codex' ||
    (!isLegacySharedCodexHome(session.codexHome) && !needsAccountRepin)
  ) {
    return session
  }
  const response = await aiVaultResumePreparationRun.request(
    client,
    {
      agent: session.agent,
      filePath: session.filePath,
      codexHome: session.codexHome,
      executionHostId: session.executionHostId
    },
    { timeoutMs: RESUME_RPC_TIMEOUT_MS }
  )
  if (!response.ok) {
    if (isAiVaultPrepareSessionResumeUnavailableError(response.error)) {
      // Why: older hosts cannot prepare, but their shared home still supports the legacy resume path.
      return session
    }
    throw new Error(
      response.error?.message || 'Could not prepare this legacy Codex session. Retry resume.'
    )
  }
  const result = aiVaultResumePreparationRun.interpret(response)
  if (result?.useRealCodexHome === true) {
    return { ...session, codexHome: null }
  }
  // Why: older hosts never send a repin home, so absence keeps the session's own home.
  if (result?.substituteCodexHome) {
    return { ...session, codexHome: result.substituteCodexHome }
  }
  return session
}

type MobileResumeAttempt = {
  worktreeId: string
  launch: MobileAiVaultResumeLaunch & { hostCapabilities?: readonly string[] }
}

export type MobileAiVaultResumeMutationRegistry = {
  freeze(
    sessionId: string,
    attempt: MobileResumeAttempt
  ): MobileResumeAttempt & { clientMutationId: string }
  claim(sessionId: string): string
  releaseOnSuccess(sessionId: string): void
}

// Reuse mutation ids after failed/interrupted resumes for deduplication; mint fresh only after success so deliberate forks remain possible.
export function createMobileAiVaultResumeMutationRegistry(
  mintId: (sessionId: string) => string
): MobileAiVaultResumeMutationRegistry {
  const registry = createAgentTerminalResumeAttemptRegistry<MobileResumeAttempt>(mintId)
  return {
    claim: registry.claim,
    freeze(sessionId, attempt) {
      const frozen = registry.freeze(sessionId, attempt)
      return { ...frozen.attempt, clientMutationId: frozen.clientMutationId }
    },
    releaseOnSuccess: registry.releaseOnSuccess
  }
}

export function normalizeMobileAiVaultResumeCommandOverrides(
  overrides: Partial<Record<TuiAgent, string | null>> | null | undefined
): Partial<Record<TuiAgent, string>> {
  const normalized: Partial<Record<TuiAgent, string>> = {}
  if (!overrides) {
    return normalized
  }
  for (const [agent, command] of Object.entries(overrides) as [TuiAgent, string | null][]) {
    if (typeof command === 'string' && command.trim()) {
      normalized[agent] = command
    }
  }
  return normalized
}
