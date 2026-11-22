import type { ProviderRateLimits } from '../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { isCodexApiKeyRateLimitError } from '../../../../shared/agent-accounts/codex/codex-auth-errors'
import { getCodexBackendAuthHeaders } from './codex-backend-auth'
import type { CodexRateLimitFetchOptions } from './codex-rate-limit-fetch-options'

const AUTH_READ_TIMEOUT_MS = 5_000

/** Marks Codex's API-key usage rejection as "usage unavailable" so no surface asks a signed-in API-key home to sign in. */
export async function classifyCodexApiKeyUsageRejection(
  result: ProviderRateLimits,
  options: CodexRateLimitFetchOptions | undefined
): Promise<ProviderRateLimits> {
  if (!isCodexApiKeyRateLimitError(result.error) || options?.signal?.aborted) {
    return result
  }
  const timeout = AbortSignal.timeout(AUTH_READ_TIMEOUT_MS)
  const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  try {
    // Codex before Jan 2026 saved ChatGPT logins with OPENAI_API_KEY and no auth_mode, which now resolve to API-key mode; signing in again fixes those.
    if ((await getCodexBackendAuthHeaders(options, signal)) || signal.aborted) {
      return result
    }
  } catch {
    return result
  }
  return {
    ...result,
    usageMetadata: { ...result.usageMetadata, failureKind: 'usage-unavailable' }
  }
}
