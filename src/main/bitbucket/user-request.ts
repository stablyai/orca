import { authHeaders, type BitbucketAuthConfig } from './bitbucket-auth-config'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'

const USER_REQUEST_TIMEOUT_MS = 4000

export type RawBitbucketUser = {
  username?: string | null
  display_name?: string | null
  account_id?: string | null
}

/**
 * Why (STA-3944): a timeout, DNS failure, 5xx, or unparseable body says nothing
 * about the credential. Collapsing those to the same miss as a 401 told users
 * their token was invalid when the network was simply unreachable.
 */
export type BitbucketUserResult =
  | { ok: true; user: RawBitbucketUser }
  | { ok: false; reason: 'rejected' | 'unreachable' }

export function accountNameFromUser(user: RawBitbucketUser | null): string | null {
  return user?.username ?? user?.display_name ?? user?.account_id ?? null
}

// Shared by live env-var status checks and by connect-time verification, so a
// credential is proven against `/user` before it is ever persisted.
export async function fetchBitbucketUserResult(
  config: BitbucketAuthConfig,
  timeoutMs: number = USER_REQUEST_TIMEOUT_MS
): Promise<BitbucketUserResult> {
  let response: Response
  try {
    const base = config.baseUrl.replace(/\/+$/, '')
    response = await fetch(`${base}/user`, {
      headers: {
        Accept: 'application/json',
        ...authHeaders(config)
      },
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch {
    return { ok: false, reason: 'unreachable' }
  }
  if (!response.ok) {
    await cancelUnreadResponseBody(response)
    // Only the credential-bearing statuses are the credential's fault; 5xx and
    // the rest are the server or the path in between.
    const rejected = response.status === 401 || response.status === 403
    return { ok: false, reason: rejected ? 'rejected' : 'unreachable' }
  }
  try {
    return { ok: true, user: (await response.json()) as RawBitbucketUser }
  } catch {
    return { ok: false, reason: 'unreachable' }
  }
}

/** Convenience for callers that only need the account, not the failure reason. */
export async function fetchBitbucketUser(
  config: BitbucketAuthConfig,
  timeoutMs: number = USER_REQUEST_TIMEOUT_MS
): Promise<RawBitbucketUser | null> {
  const result = await fetchBitbucketUserResult(config, timeoutMs)
  return result.ok ? result.user : null
}
