import { createHash } from 'node:crypto'
import { getMainHttpClient } from '../../../network/http-client'
import type {
  ProviderRateLimits,
  RateLimitWindow,
  UsageRateLimitMetadata
} from '../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { abortSignalWithTimeout } from '../../../lib/abort-signal-with-timeout'
import { classifyThrownUsageRequestError } from '../usage-request-failure-kind'
import { parseUsageRetryAfterMs } from '../usage-retry-after'
import {
  readMistralVibeCredential,
  type MistralVibeCredential,
  type MistralVibeCredentialRead
} from './mistral-vibe-credentials'

// Vibe's footer gauge reads this public billing endpoint (vibe/app_server/_billing.py).
const BUDGET_URL = 'https://api.mistral.ai/v1/billing/budget'
const API_TIMEOUT_MS = 10_000
const MONTHLY_WINDOW_MINUTES = 43_200
// Vibe treats an ID token as stale 30s before expiry; it refreshes, Orca only reads.
const ID_TOKEN_SKEW_SECONDS = 30

function result(
  status: ProviderRateLimits['status'],
  error: string | null,
  usageMetadata?: UsageRateLimitMetadata
): ProviderRateLimits {
  return {
    provider: 'mistral-vibe',
    session: null,
    weekly: null,
    monthly: null,
    updatedAt: Date.now(),
    error,
    status,
    ...(usageMetadata ? { usageMetadata } : {})
  }
}

function resetDescription(resetsAt: number | null): string | null {
  if (resetsAt === null) {
    return null
  }
  return new Date(resetsAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Map `/v1/billing/budget`; a missing or zero allowance means the plan has no Vibe Code budget. */
export function mapMistralVibeBudgetResponse(data: unknown): ProviderRateLimits {
  const budget =
    typeof data === 'object' && data !== null
      ? (data as { vibe_budget?: unknown }).vibe_budget
      : undefined
  if (typeof budget !== 'object' || budget === null) {
    return result('unavailable', 'No Mistral Vibe budget on this account')
  }
  const {
    usage_percentage: usage,
    initial_budget: initial,
    reset_at: resetAt
  } = budget as Record<string, unknown>
  if (typeof usage !== 'number' || !Number.isFinite(usage)) {
    return result('error', 'Mistral Vibe usage response was invalid', { failureKind: 'parse' })
  }
  if (typeof initial !== 'number' || !(initial > 0)) {
    return result('unavailable', 'No Mistral Vibe budget on this account')
  }
  const parsedReset = typeof resetAt === 'string' ? Date.parse(resetAt) : Number.NaN
  const resetsAt = Number.isFinite(parsedReset) ? parsedReset : null
  const monthly: RateLimitWindow = {
    usedPercent: Math.min(100, Math.max(0, usage)),
    windowMinutes: MONTHLY_WINDOW_MINUTES,
    resetsAt,
    resetDescription: resetDescription(resetsAt)
  }
  return { ...result('ok', null, { source: 'oauth' }), monthly }
}

function authHeaders(credential: MistralVibeCredential): Record<string, string> | null {
  if (credential.kind === 'api-key') {
    return { Authorization: `Bearer ${credential.apiKey}` }
  }
  if (credential.kind === 'oidc') {
    // The gateway needs the tenant with an ID token (Vibe's _oidc_runtime.oidc_headers).
    return {
      Authorization: `Bearer ${credential.session.idToken}`,
      'x-external-organization-id': credential.session.organizationId,
      'x-external-workspace-id': credential.session.workspaceId
    }
  }
  return null
}

function provenance(credential: MistralVibeCredential): string | undefined {
  const material =
    credential.kind === 'api-key'
      ? credential.apiKey
      : credential.kind === 'oidc'
        ? `${credential.session.organizationId}|${credential.session.workspaceId}`
        : null
  return material === null
    ? undefined
    : createHash('sha256').update(material).digest('hex').slice(0, 16)
}

function isIdTokenFresh(expiresAt: number | null): boolean {
  return expiresAt === null || expiresAt - Date.now() / 1000 > ID_TOKEN_SKEW_SECONDS
}

const RUN_VIBE = 'Mistral Vibe session expired — run vibe, then retry usage.'

/** Read the Vibe Code monthly budget with the credential the Vibe CLI uses.
 * Vibe owns OIDC refresh-token rotation: never refresh or write its keyring slot. */
export async function fetchMistralVibeRateLimits(options?: {
  signal?: AbortSignal
  credentialRead?: MistralVibeCredentialRead
}): Promise<ProviderRateLimits> {
  const read = options?.credentialRead ?? (await readMistralVibeCredential())
  if (read.status === 'missing') {
    return result('unavailable', 'Not signed in to Mistral Vibe', {
      failureKind: 'missing-credentials'
    })
  }
  if (read.status === 'error') {
    return result('error', read.error, { failureKind: 'keychain-unavailable' })
  }
  const { credential } = read
  if (credential.kind === 'oidc-without-tenant') {
    return result('error', RUN_VIBE, { failureKind: 'delegated-refresh-required' })
  }
  if (credential.kind === 'oidc' && !isIdTokenFresh(credential.session.idTokenExpiresAt)) {
    // Transient error keeps the last good reading until Vibe refreshes its token.
    return result('error', RUN_VIBE, { failureKind: 'delegated-refresh-required' })
  }
  const headers = authHeaders(credential)
  if (!headers) {
    return result('error', RUN_VIBE, { failureKind: 'delegated-refresh-required' })
  }
  const credentialSource = credential.kind === 'api-key' ? credential.source : 'oidc'
  const authProvenance = provenance(credential)
  const metadata = (extra: UsageRateLimitMetadata = {}): UsageRateLimitMetadata => ({
    credentialSource,
    ...(authProvenance ? { authProvenance } : {}),
    ...extra
  })

  try {
    const res = await getMainHttpClient().fetch(BUDGET_URL, {
      headers: { ...headers, Accept: 'application/json' },
      signal: abortSignalWithTimeout(options?.signal, API_TIMEOUT_MS)
    })
    if (res.status === 401) {
      return result(
        'error',
        credential.kind === 'oidc' ? RUN_VIBE : 'Mistral API key was rejected (HTTP 401)',
        metadata({
          failureKind: credential.kind === 'oidc' ? 'delegated-refresh-required' : 'stale-token'
        })
      )
    }
    if (res.status === 403) {
      // /budget needs the see_org_inference_usage permission; org members may lack it.
      return result(
        'error',
        'Mistral Vibe usage needs permission to view organization usage',
        metadata({ failureKind: 'missing-scope' })
      )
    }
    if (res.status === 404) {
      return result('unavailable', 'No Mistral Vibe budget on this account', metadata())
    }
    if (res.status === 429) {
      const retryAfterMs = parseUsageRetryAfterMs(res.headers.get('retry-after'))
      return result(
        'error',
        'Mistral Vibe usage request was rate limited',
        metadata({
          failureKind: 'rate-limited',
          ...(retryAfterMs !== null ? { retryAtMs: Date.now() + retryAfterMs } : {})
        })
      )
    }
    if (!res.ok) {
      return result(
        'error',
        `Mistral Vibe usage request failed (HTTP ${res.status})`,
        metadata({ failureKind: res.status >= 500 ? 'server' : 'unknown' })
      )
    }
    const mapped = mapMistralVibeBudgetResponse(await res.json())
    return { ...mapped, usageMetadata: { ...mapped.usageMetadata, ...metadata() } }
  } catch (err) {
    return result(
      'error',
      err instanceof Error ? err.message : 'Mistral Vibe usage request failed',
      metadata({ failureKind: classifyThrownUsageRequestError(err) })
    )
  }
}
