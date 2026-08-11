import { authHeaders, type BitbucketAuthConfig } from './bitbucket-auth-config'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'

const USER_REQUEST_TIMEOUT_MS = 4000

export type RawBitbucketUser = {
  username?: string | null
  display_name?: string | null
  account_id?: string | null
}

export function accountNameFromUser(user: RawBitbucketUser | null): string | null {
  return user?.username ?? user?.display_name ?? user?.account_id ?? null
}

// Shared by live env-var status checks and by connect-time verification, so a
// credential is proven against `/user` before it is ever persisted.
export async function fetchBitbucketUser(
  config: BitbucketAuthConfig,
  timeoutMs: number = USER_REQUEST_TIMEOUT_MS
): Promise<RawBitbucketUser | null> {
  try {
    const base = config.baseUrl.replace(/\/+$/, '')
    const response = await fetch(`${base}/user`, {
      headers: {
        Accept: 'application/json',
        ...authHeaders(config)
      },
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!response.ok) {
      await cancelUnreadResponseBody(response)
      return null
    }
    return (await response.json()) as RawBitbucketUser
  } catch {
    return null
  }
}
