// Reuses a minted billing token until shortly before it expires. Auth rate-limits mints per user
// (and each one does a live roster lookup), and its route asks clients to reuse the token until
// near expiry; without this the setup page's polls alone used most of the per-minute budget.
// Keyed by profile, signed-in user and team; the token epoch (bumped on a team switch, sign-out or
// any membership or role change) drops every entry, and a billing 401/403 drops the one used.
import { getOrcaCloudTokenEpoch } from '../orca-profiles/cloud-token-epoch'

/** Mint again this long before the token's own expiry, so a call never carries a dying token. */
const REFRESH_BEFORE_EXPIRY_MS = 60_000

type Entry = { token: string; expiresAt: number; epoch: number }

const entries = new Map<string, Entry>()
const inflight = new Map<string, Promise<string>>()

/** The token's `exp` claim in ms; null when it has none (then the token is never reused). */
function tokenExpiry(token: string): number | null {
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')
    )
    const exp =
      typeof payload === 'object' && payload !== null && 'exp' in payload ? payload.exp : null
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null
  } catch {
    return null
  }
}

/** A cached token for `key`, or a fresh one from `mint` (concurrent callers share one mint). */
export async function cachedBillingToken(
  key: string,
  mint: () => Promise<string>,
  now: () => number = Date.now
): Promise<string> {
  const epoch = getOrcaCloudTokenEpoch()
  const cached = entries.get(key)
  if (cached && cached.epoch === epoch && cached.expiresAt - REFRESH_BEFORE_EXPIRY_MS > now()) {
    return cached.token
  }
  const pending = inflight.get(key)
  if (pending) {
    return pending
  }
  const minted = mint()
    .then((token) => {
      const expiresAt = tokenExpiry(token)
      // A token minted under an older epoch (a switch landed mid-mint) is used once, never kept.
      if (expiresAt !== null && epoch === getOrcaCloudTokenEpoch()) {
        entries.set(key, { token, expiresAt, epoch })
      }
      return token
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, minted)
  return minted
}

/** Billing refused the token (401/403): the next call mints a new one. */
export function forgetBillingToken(key: string, token: string): void {
  if (entries.get(key)?.token === token) {
    entries.delete(key)
  }
}

export function resetBillingTokenCacheForTests(): void {
  entries.clear()
  inflight.clear()
}
