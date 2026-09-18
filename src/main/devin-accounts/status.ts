import type { DevinAccountStatus, ProviderRateLimits } from '../../shared/rate-limit-types'
import { readDevinCredentials } from '../rate-limits/devin-credentials'

export function getDevinAccountStatus(limits: ProviderRateLimits | null): DevinAccountStatus {
  const readResult = readDevinCredentials()
  if (readResult.status === 'missing') {
    return { signedIn: false, email: null, tokenFresh: false, plan: null, error: null }
  }
  if (readResult.status === 'error') {
    return {
      signedIn: false,
      email: null,
      tokenFresh: false,
      plan: null,
      error: readResult.error
    }
  }
  const delegatedRefreshRequired =
    limits?.usageMetadata?.failureKind === 'delegated-refresh-required'
  return {
    signedIn: true,
    email: limits?.usageMetadata?.authProvenance ?? null,
    tokenFresh: !delegatedRefreshRequired,
    plan: limits?.planType ?? null,
    error: delegatedRefreshRequired ? limits.error : null
  }
}
