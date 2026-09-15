import type {
  ProviderRateLimits,
  UsageRateLimitFailureKind,
  UsageRateLimitMetadata
} from '../../shared/rate-limit-types'
import { fetchAntigravityQuota } from './antigravity-cloud-code-api'
import { findAntigravityCredential } from './antigravity-credential-hosts'
import {
  ANTIGRAVITY_SESSION_WINDOW,
  ANTIGRAVITY_WEEKLY_WINDOW,
  buildAntigravityBuckets,
  mostConstrainedWindow,
  toRateLimitBuckets
} from './antigravity-quota-buckets'

function unusable(
  status: 'error' | 'unavailable',
  error: string,
  failureKind: UsageRateLimitFailureKind,
  metadata: UsageRateLimitMetadata = {}
): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status,
    usageMetadata: { source: 'oauth', failureKind, ...metadata }
  }
}

/**
 * Reads Antigravity's own quota from the Antigravity credential, on whichever
 * execution host holds one. No `agy` process has to be running or reachable.
 */
export async function fetchAntigravityRateLimits(
  signal?: AbortSignal
): Promise<ProviderRateLimits> {
  const lookup = await findAntigravityCredential()
  if (lookup.status === 'missing') {
    return unusable(
      'unavailable',
      'Antigravity usage is not available. Sign in to the Antigravity CLI on this machine or on a connected SSH host.',
      'missing-credentials'
    )
  }
  if (lookup.status === 'expired') {
    return unusable(
      'unavailable',
      `Antigravity sign-in on ${lookup.hostLabel} has expired. Run the Antigravity CLI there to refresh it.`,
      'stale-token',
      { credentialSource: lookup.hostLabel }
    )
  }
  if (lookup.status === 'unverifiable') {
    // Why: contact was lost before absence could be established, so this must not be
    // reported as "no sign-in" (docs/reference/ssh-execution-boundary.md).
    return unusable(
      'error',
      `Antigravity usage could not be checked on ${lookup.hostLabel}. ${lookup.message}`,
      'network',
      { credentialSource: lookup.hostLabel }
    )
  }

  const { credential, hostLabel } = lookup.found
  const quota = await fetchAntigravityQuota(credential.accessToken, signal)
  if (quota.status === 'unauthorized') {
    return unusable(
      'error',
      `Antigravity rejected the sign-in stored on ${hostLabel}.`,
      'stale-token',
      { credentialSource: hostLabel }
    )
  }
  if (quota.status === 'not-entitled') {
    return unusable(
      'unavailable',
      'This Google account has no Antigravity quota grant.',
      'usage-unavailable',
      { credentialSource: hostLabel }
    )
  }
  if (quota.status === 'error') {
    return unusable('error', quota.message, 'server', { credentialSource: hostLabel })
  }

  const buckets = buildAntigravityBuckets(quota.groups)
  if (buckets.length === 0) {
    return unusable('error', 'Antigravity returned no recognisable quota windows.', 'parse', {
      credentialSource: hostLabel
    })
  }
  return {
    provider: 'antigravity',
    session: mostConstrainedWindow(buckets, ANTIGRAVITY_SESSION_WINDOW),
    weekly: mostConstrainedWindow(buckets, ANTIGRAVITY_WEEKLY_WINDOW),
    buckets: toRateLimitBuckets(buckets),
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    usageMetadata: { source: 'oauth', credentialSource: hostLabel }
  }
}
