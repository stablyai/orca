import type { ProviderRateLimits, RateLimitRuntimeTarget } from '../../shared/rate-limit-types'
import {
  isSameRuntimeTarget,
  type AntigravityUsageLogin
} from '../rate-limits/providers/antigravity/antigravity-account-usage'
import type { StoredAntigravityAccount, StoredAntigravityUsage } from './native-account-store'
import type { AntigravityNativeCredential } from './native-credential-codec'

// agy's token refresh drops the id_token but keeps the grant's refresh token.
export function isSameAntigravityLogin(
  left: AntigravityNativeCredential,
  right: AntigravityNativeCredential
): boolean {
  if (left.authMethod !== right.authMethod) {
    return false
  }
  if (left.identity && right.identity) {
    return left.identity.subject === right.identity.subject
  }
  if (left.refreshToken && right.refreshToken) {
    return left.refreshToken === right.refreshToken
  }
  return left.contents === right.contents
}

export function antigravityUsageLogin(
  account: StoredAntigravityAccount | undefined,
  current: AntigravityNativeCredential
): AntigravityUsageLogin {
  // A saved account keeps its subject across refreshes that drop the id_token.
  const subject = current.identity?.subject ?? account?.subject
  return {
    key: `${current.authMethod}\n${subject ?? current.refreshToken ?? current.contents}`,
    accountId: account?.id ?? null,
    email: current.identity?.email ?? account?.email ?? null
  }
}

export function storedAntigravityReading(
  account: StoredAntigravityAccount,
  target: RateLimitRuntimeTarget
): ProviderRateLimits | null {
  return (
    account.usage?.find((entry) => isSameRuntimeTarget(entry.target, target))?.rateLimits ?? null
  )
}

export function withStoredAntigravityReading(
  account: StoredAntigravityAccount,
  target: RateLimitRuntimeTarget,
  rateLimits: ProviderRateLimits
): StoredAntigravityUsage[] {
  return [
    ...(account.usage ?? []).filter((entry) => !isSameRuntimeTarget(entry.target, target)),
    { target, rateLimits }
  ]
}
