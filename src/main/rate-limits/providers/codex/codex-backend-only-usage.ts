import type { ProviderRateLimits } from '../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { abortSignalWithTimeout } from '../../../lib/abort-signal-with-timeout'
import { readCodexJwtExpiryMs } from '../../../codex-accounts/credentials/codex-auth-identity'
import {
  CODEX_BACKEND_TIMEOUT_MS,
  codexBackendAuthHeaders,
  readCodexBackendTokens,
  type CodexBackendRequest,
  type CodexBackendTokens
} from './codex-backend-auth'
import { requestCodexBackendUsage } from './codex-backend-usage-client'
import type { CodexRateLimitFetchOptions } from './codex-rate-limit-fetch-options'

/** Codex renews a lapsed access token on its next run, so the login is not signed out. */
function waitingForCodex(): ProviderRateLimits {
  return {
    provider: 'codex',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: 'Codex access token expired; usage updates the next time Codex runs',
    status: 'error',
    usageMetadata: { source: 'web', failureKind: 'delegated-refresh-required' }
  }
}

/** API-key, Bedrock and unparseable logins have no ChatGPT usage to read. */
function usageUnavailable(): ProviderRateLimits {
  return {
    provider: 'codex',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: 'Codex usage is unavailable for this login',
    status: 'unavailable',
    usageMetadata: { source: 'web', failureKind: 'usage-unavailable' }
  }
}

async function readTokensUnlessUnparseable(
  options: CodexRateLimitFetchOptions | undefined,
  signal: AbortSignal
): Promise<CodexBackendTokens | null> {
  try {
    return await readCodexBackendTokens(options, signal)
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null
    }
    throw error
  }
}

/** One HTTP read that never spawns Codex, so a login Orca has not selected never has its tokens rotated. */
export async function readCodexBackendOnlyUsage(
  request: CodexBackendRequest,
  options: CodexRateLimitFetchOptions | undefined
): Promise<ProviderRateLimits | null> {
  const signal = abortSignalWithTimeout(options?.signal, CODEX_BACKEND_TIMEOUT_MS)
  const tokens = await readTokensUnlessUnparseable(options, signal)
  if (signal.aborted) {
    return null
  }
  if (!tokens) {
    return usageUnavailable()
  }
  const expiresAtMs = readCodexJwtExpiryMs(tokens.accessToken)
  if (expiresAtMs !== null && expiresAtMs <= Date.now()) {
    return waitingForCodex()
  }
  const result = await requestCodexBackendUsage(request, codexBackendAuthHeaders(tokens), signal)
  return result?.usageMetadata?.failureKind === 'stale-token' ? waitingForCodex() : result
}
