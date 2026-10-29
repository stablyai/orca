import { readFetchResponseJsonWithinLimit } from '../../shared/fetch-response-body'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import { getMainHttpClient } from '../network/http-client'
import {
  readGoogleIdentityClaims,
  type AntigravityCredentialIdentity
} from './native-credential-codec'

const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo'
const REJECTED =
  'Google rejected the current Antigravity credential. Run agy once to refresh it, then save again.'
const UNCONFIRMED = 'Google did not confirm the signed-in Antigravity account; nothing was saved.'

export async function fetchGoogleIdentity(
  accessToken: string
): Promise<AntigravityCredentialIdentity> {
  let response: Response
  try {
    response = await getMainHttpClient().fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000)
    })
  } catch {
    throw new Error(
      'Could not reach Google to identify the Antigravity account; nothing was saved.'
    )
  }
  if (!response.ok) {
    await cancelUnreadResponseBody(response)
    throw new Error(response.status === 401 ? REJECTED : UNCONFIRMED)
  }
  const claims = await readFetchResponseJsonWithinLimit<unknown>(response, 16 * 1024).catch(
    () => null
  )
  const identity = readGoogleIdentityClaims(claims)
  if (!identity) {
    throw new Error(UNCONFIRMED)
  }
  return identity
}
