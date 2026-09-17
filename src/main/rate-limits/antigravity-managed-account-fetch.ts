import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import type { AntigravityManagedAccount } from '../../shared/managed-account-types'
import { refreshAntigravityAccountToken } from '../antigravity-accounts/managed-oauth'
import {
  createAntigravityTokenStore,
  type AntigravityTokenStore
} from '../antigravity-accounts/token-store'
import { fetchAntigravityQuota } from './antigravity-quota-client'

export function errorResult(error: string): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status: 'error'
  }
}

// Why: settings live in the main store; the fetcher reads them through this
// provider so the rate-limit service stays decoupled from GlobalSettings.
let managedAccountsProvider: () => AntigravityManagedAccount[] = () => []

export function setAntigravityManagedAccountsProvider(
  provider: () => AntigravityManagedAccount[]
): void {
  managedAccountsProvider = provider
}

let tokenStoreSingleton: AntigravityTokenStore | null = null

function getSharedTokenStore(): AntigravityTokenStore {
  if (!tokenStoreSingleton) {
    tokenStoreSingleton = createAntigravityTokenStore()
  }
  return tokenStoreSingleton
}

export function setAntigravityTokenStoreForTests(store: AntigravityTokenStore | null): void {
  tokenStoreSingleton = store
}

/** Fetches quota for one managed account, refreshing (and persisting) its
 *  token through the safeStorage vault when expired. */
export async function fetchAntigravityManagedAccountUsage(
  account: AntigravityManagedAccount,
  tokenStore?: AntigravityTokenStore
): Promise<ProviderRateLimits> {
  const store = tokenStore ?? getSharedTokenStore()
  let tokens = await store.read(account.id)
  if (!tokens) {
    return errorResult(
      `Antigravity account ${account.email} has no stored credentials — remove and re-add it`
    )
  }
  let accessToken: string | null = tokens.accessToken
  if (!accessToken || (tokens.expiryDate ?? 0) < Date.now()) {
    try {
      const refreshed = await refreshAntigravityAccountToken(tokens.refreshToken)
      tokens = {
        refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
        accessToken: refreshed.accessToken,
        expiryDate: refreshed.expiryDate
      }
      accessToken = refreshed.accessToken
      await store.write(account.id, tokens)
    } catch (err) {
      return errorResult(
        `Token refresh failed for ${account.email}: ${err instanceof Error ? err.message : 'unknown error'}`
      )
    }
  }
  return fetchAntigravityQuota(accessToken, account.projectId)
}

/** Fetches every managed account and collapses them into the single
 *  status-bar snapshot (null when no accounts are configured). */
export async function fetchManagedAccountsAggregate(): Promise<ProviderRateLimits | null> {
  const accounts = managedAccountsProvider()
  if (accounts.length === 0) {
    return null
  }
  const results = await Promise.all(
    accounts.map((account) => fetchAntigravityManagedAccountUsage(account).catch(() => null))
  )
  const usable = results.filter(
    (result): result is ProviderRateLimits => result !== null && result.status === 'ok'
  )
  if (usable.length === 0) {
    const firstError = results.find((result) => result !== null)
    return firstError ?? errorResult('Antigravity accounts failed to fetch')
  }
  // Why: one status-bar segment summarizes all signed-in accounts; the most
  // constrained window is the actionable one (mirrors multi-account claude).
  return usable.reduce((worst, candidate) =>
    (candidate.session?.usedPercent ?? 0) > (worst.session?.usedPercent ?? 0) ? candidate : worst
  )
}
