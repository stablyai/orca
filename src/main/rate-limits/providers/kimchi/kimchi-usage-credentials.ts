import type { ProviderRateLimits } from '../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { readKimchiUsageAuth } from './kimchi-auth'

const UNAUTHENTICATED_PROVENANCE = 'unauthenticated'

export async function ensureKimchiUsageCredentialCurrent(
  settled: ProviderRateLimits
): Promise<ProviderRateLimits> {
  const settledProvenance = settled.usageMetadata?.authProvenance
  if (settledProvenance === undefined) {
    return settled
  }
  const latestAuth = await readKimchiUsageAuth()
  const latestProvenance =
    latestAuth.status === 'ok' ? latestAuth.auth.authProvenance : UNAUTHENTICATED_PROVENANCE
  if (settledProvenance === latestProvenance) {
    return settled
  }
  return {
    provider: 'kimchi',
    session: null,
    weekly: null,
    monthly: null,
    updatedAt: Date.now(),
    error: 'Kimchi account changed during refresh',
    status: 'error',
    usageMetadata: {
      source: 'cli',
      authProvenance: latestProvenance,
      failureKind: 'missing-credentials'
    }
  }
}
