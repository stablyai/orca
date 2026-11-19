import { authHeaders, type BitbucketAuthConfig } from './bitbucket-auth-config'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'

const USER_REQUEST_TIMEOUT_MS = 4000

export type RawBitbucketUser = {
  username?: string | null
  display_name?: string | null
  account_id?: string | null
}

/** Network, server and decode failures do not prove the credentials are invalid. */
export type BitbucketUserResult =
  | { ok: true; user: RawBitbucketUser | null }
  | { ok: false; reason: 'rejected' | 'unreachable' }

export function accountNameFromUser(user: RawBitbucketUser | null): string | null {
  return user?.username ?? user?.display_name ?? user?.account_id ?? null
}

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
  // Bitbucket answers 401 to bad credentials; its 403 means it accepted them without account access
  // (every access token, and API tokens without read:user:bitbucket).
  if (response.status === 403) {
    return (await isBitbucketErrorBody(response))
      ? { ok: true, user: null }
      : { ok: false, reason: 'unreachable' }
  }
  if (!response.ok) {
    await cancelUnreadResponseBody(response)
    return { ok: false, reason: response.status === 401 ? 'rejected' : 'unreachable' }
  }
  try {
    return { ok: true, user: (await response.json()) as RawBitbucketUser }
  } catch {
    return { ok: false, reason: 'unreachable' }
  }
}

// A proxy or non-Bitbucket base URL can answer 403 without checking the credential.
async function isBitbucketErrorBody(response: Response): Promise<boolean> {
  try {
    const body: unknown = await response.json()
    return typeof body === 'object' && body !== null && 'type' in body && body.type === 'error'
  } catch {
    return false
  }
}
