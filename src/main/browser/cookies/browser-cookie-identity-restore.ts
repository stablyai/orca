import type { CookieClearIdentity } from './storage/cookie-store-contracts'

export async function restoreEveryCookieIdentity(
  identities: readonly CookieClearIdentity[],
  restore: (identity: CookieClearIdentity) => Promise<void>
): Promise<void> {
  const failures: unknown[] = []
  for (const identity of identities) {
    try {
      await restore(identity)
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `Could not restore ${failures.length} cookie(s)`)
  }
}
