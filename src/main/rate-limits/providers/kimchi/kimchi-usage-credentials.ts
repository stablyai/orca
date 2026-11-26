import type { ProviderRateLimits } from '../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { readKimchiUsageAuth } from './kimchi-auth'

const UNAUTHENTICATED_PROVENANCE = 'unauthenticated'

async function currentKimchiUsageProvenance(): Promise<string> {
  const latestAuth = await readKimchiUsageAuth()
  return latestAuth.status === 'ok' ? latestAuth.auth.authProvenance : UNAUTHENTICATED_PROVENANCE
}

export async function isKimchiUsageCredentialCurrent(
  settled: ProviderRateLimits | null
): Promise<boolean> {
  const settledProvenance = settled?.usageMetadata?.authProvenance
  return (
    settledProvenance === undefined || settledProvenance === (await currentKimchiUsageProvenance())
  )
}

export async function ensureKimchiUsageCredentialCurrent(
  settled: ProviderRateLimits
): Promise<ProviderRateLimits> {
  const settledProvenance = settled.usageMetadata?.authProvenance
  if (settledProvenance === undefined) {
    return settled
  }
  const latestProvenance = await currentKimchiUsageProvenance()
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
