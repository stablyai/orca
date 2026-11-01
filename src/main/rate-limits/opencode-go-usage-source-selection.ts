import type { NetworkProxySettings } from '../../shared/network-proxy'
import type { ProviderRateLimits, UsageRateLimitMetadata } from '../../shared/rate-limit-types'
import {
  resolveOpenCodeGoApiKey,
  type OpenCodeGoApiKeyResolution
} from './opencode-go-api-key-source'
import { makeOpenCodeGoZenBalance, type OpenCodeGoUsageWindows } from './opencode-go-status-parsing'
import type { OpenCodeCredentialBackend } from '../opencode/opencode-credential-backend'
import {
  fetchOpenCodeGoUsageWithApiKey,
  type OpenCodeGoUsageApiOutcome
} from './opencode-go-usage-api'
import { fetchOpenCodeGoRateLimits, normalizeCookieInput } from './opencode-go-usage-fetcher'

export type OpenCodeGoUsageSourceInput = {
  /** Explicit Orca override; the highest-precedence key tier. */
  settingsApiKey?: string
  environment?: NodeJS.ProcessEnv
  backend?: OpenCodeCredentialBackend
  cwd?: string
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
    extraUsage: makeOpenCodeGoZenBalance(null, 'api-key-source'),
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    usageMetadata: { source: 'web', credentialSource }
  }
}

// Keep auth and entitlement verdicts actionable; generic parse errors misled #22257.
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
    failureKind: outcome.failureKind ?? 'server'
  })
}

/** Prefer the keyed usage endpoint; retain cookie fallback for Black and other legacy-console accounts. */
export async function fetchOpenCodeGoUsage(
  input: OpenCodeGoUsageSourceInput
): Promise<ProviderRateLimits> {
  const context = input.settingsApiKey?.trim()
    ? {}
    : {
        ...(input.environment ? { environment: input.environment } : {}),
        ...(input.backend ? { backend: input.backend } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {})
      }
  const apiKeyResolution = await resolveOpenCodeGoApiKey({
    settingsOverride: input.settingsApiKey,
    ...context
  })
  input.onApiKeyResolved?.(apiKeyResolution)
  const hasCookie = Boolean(normalizeCookieInput(input.cookie))
  if (apiKeyResolution.status === 'credential-database-unreadable' && !hasCookie) {
    return emptyResult(
      "Could not read OpenCode's credential database, so OPENCODE_API_KEY was not used; it may be a Zen key. Add your OpenCode Go key in Settings, or retry.",
      'error',
      { failureKind: 'usage-unavailable' }
    )
  }
  if (apiKeyResolution.status !== 'found') {
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
  // Black-only keys lack Go entitlement; those accounts still need console-session usage.
  const cookieResult = await fetchOpenCodeGoRateLimits(
    input.cookie,
    input.workspaceIdOverride,
    input.networkProxySettings
  )
  return cookieResult.status === 'ok' ? cookieResult : apiFailureResult(outcome, tier)
}
