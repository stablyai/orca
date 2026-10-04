import { decodeAccountsSnapshot, type AccountsSnapshot } from '../components/accounts-snapshot'

export function readCachedHomeAccounts(value: unknown): Record<string, AccountsSnapshot> {
  const accounts: Record<string, AccountsSnapshot> = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return accounts
  }
  for (const [hostId, cached] of Object.entries(value)) {
    try {
      const snapshot = decodeAccountsSnapshot(cached)
      // Persisted money has no current credential-owner evidence.
      accounts[hostId] = {
        ...snapshot,
        rateLimits: { ...snapshot.rateLimits, deepseek: null, deepseekAccount: null }
      }
    } catch {
      // An older cache may not carry the current account shape.
    }
  }
  return accounts
}
