import type { NetworkProxySettings } from '../../shared/network-proxy'
import type { ProviderRateLimits, UsageRateLimitMetadata } from '../../shared/rate-limit-types'
import {
  resolveOpenCodeGoApiKey,
  type OpenCodeGoApiKeyResolution
} from './opencode-go-api-key-source'
import type { OpenCodeGoUsageWindows } from './opencode-go-status-parsing'
import {
  fetchOpenCodeGoUsageWithApiKey,
  type OpenCodeGoUsageApiOutcome
} from './opencode-go-usage-api'
import { fetchOpenCodeGoRateLimits, normalizeCookieInput } from './opencode-go-usage-fetcher'

export type OpenCodeGoUsageSourceInput = {
  /** Explicit Orca override; the highest-precedence key tier. */
  settingsApiKey?: string
  cookie: string
  workspaceIdOverride?: string
  networkProxySettings?: NetworkProxySettings
  signal?: AbortSignal
  /** Lets the caller record key presence without handling the key itself. */
  onApiKeyResolved?: (resolution: OpenCodeGoApiKeyResolution) => void
}

function emptyResult(
  error: string,
  status: 'error' | 'unavailable',
  usageMetadata?: UsageRateLimitMetadata
): ProviderRateLimits {
  return {
    provider: 'opencode-go',
    session: null,
    weekly: null,
    monthly: null,
    updatedAt: Date.now(),
    error,
    status,
    ...(usageMetadata ? { usageMetadata } : {})
  }
}

function usageResult(
  windows: OpenCodeGoUsageWindows,
  credentialSource: string
): ProviderRateLimits {
  return {
    provider: 'opencode-go',
    session: windows.session,
    weekly: windows.weekly,
    monthly: windows.monthly,
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    usageMetadata: { source: 'web', credentialSource }
  }
}

// Why explicit copy per verdict: #22257's reporter was misled by a generic
// "could not parse" for what was really an entitlement answer, so each verdict
// says what the account's state is and what to do about it.
function apiFailureResult(
  outcome: Exclude<OpenCodeGoUsageApiOutcome, { kind: 'ok' }>,
  credentialSource: string
): ProviderRateLimits {
  if (outcome.kind === 'no-subscription') {
    return emptyResult(
      'This OpenCode account has no OpenCode Go subscription. Subscribe at opencode.ai to see Go usage.',
      'error',
      { source: 'web', credentialSource, failureKind: 'no-subscription' }
    )
  }
  if (outcome.kind === 'unauthorized') {
    return emptyResult(
      'The OpenCode Go API key was rejected. Run /connect in OpenCode, or replace the key in Settings.',
      'error',
      { source: 'web', credentialSource, failureKind: 'stale-token' }
    )
  }
  return emptyResult(outcome.message, 'error', {
    source: 'web',
    credentialSource,
    failureKind: 'server'
  })
}

/**
 * Fetch OpenCode Go usage from the best source the account offers.
 *
 * The keyed `GET /zen/go/v1/usage` endpoint is tried first because it needs no
 * console session; the legacy cookie path stays as the fallback for Black and
 * other legacy-console accounts, which upstream `fe51b0b19a` still serves.
 * @param input.settingsApiKey - Explicit Orca override, if the user set one.
 * @param input.cookie - The opencode.ai cookie header from Orca settings.
 * @returns A provider snapshot for the status bar.
 */
export async function fetchOpenCodeGoUsage(
  input: OpenCodeGoUsageSourceInput
): Promise<ProviderRateLimits> {
  const apiKeyResolution = await resolveOpenCodeGoApiKey({
    settingsOverride: input.settingsApiKey
  })
  input.onApiKeyResolved?.(apiKeyResolution)
  const hasCookie = Boolean(normalizeCookieInput(input.cookie))
  if (apiKeyResolution.status === 'missing') {
    return hasCookie
      ? fetchOpenCodeGoRateLimits(
          input.cookie,
          input.workspaceIdOverride,
          input.networkProxySettings
        )
      : emptyResult('No OpenCode Go API key or session cookie configured', 'unavailable', {
          failureKind: 'missing-credentials'
        })
  }

  const { key, tier } = apiKeyResolution
  const outcome = await fetchOpenCodeGoUsageWithApiKey(key, input.signal)
  if (outcome.kind === 'ok') {
    return usageResult(outcome.windows, tier)
  }
  if (!hasCookie) {
    return apiFailureResult(outcome, tier)
  }
  // A Black-only account holds a key with no Go entitlement, so its usage still
  // only exists behind the console session; keep that path working.
  const cookieResult = await fetchOpenCodeGoRateLimits(
    input.cookie,
    input.workspaceIdOverride,
    input.networkProxySettings
  )
  return cookieResult.status === 'ok' ? cookieResult : apiFailureResult(outcome, tier)
}
