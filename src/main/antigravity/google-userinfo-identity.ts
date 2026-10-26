import { getMainHttpClient, type MainHttpClient } from '../network/http-client'

export type ResolvedGoogleIdentity = { subject: string; email: string | null }
export type AntigravityIdentityResolver = (accessToken: string) => Promise<ResolvedGoogleIdentity>

const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo'
const LOOKUP_TIMEOUT_MS = 10_000
const MAX_RESPONSE_CHARS = 16 * 1024
const MAX_SUBJECT_CHARS = 256

const UNREACHABLE =
  'Could not reach Google to identify the signed-in Antigravity account; nothing was saved.'
const REJECTED =
  'Google rejected the current Antigravity credential. Run agy once to refresh it, then save again.'
const UNCONFIRMED = 'Google did not confirm the signed-in Antigravity account; nothing was saved.'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

// Why: a credential without an id_token carries no Google subject, so Google itself must name the account.
// Errors never include the token or Google's response body.
export function createGoogleUserinfoResolver(
  getClient: () => Pick<MainHttpClient, 'fetch'> = getMainHttpClient
): AntigravityIdentityResolver {
  return async (accessToken) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS)
    try {
      let response: Response
      try {
        response = await getClient().fetch(USERINFO_URL, {
          method: 'GET',
          headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
          redirect: 'error',
          signal: controller.signal
        })
      } catch {
        throw new Error(UNREACHABLE)
      }
      if (response.status === 401 || response.status === 403) {
        await discardBody(response)
        throw new Error(REJECTED)
      }
      if (!response.ok) {
        await discardBody(response)
        throw new Error(UNCONFIRMED)
      }
      let claims: unknown
      try {
        const text = await response.text()
        claims = text.length <= MAX_RESPONSE_CHARS ? JSON.parse(text) : null
      } catch {
        throw new Error(UNCONFIRMED)
      }
      if (
        !isRecord(claims) ||
        typeof claims.sub !== 'string' ||
        !claims.sub.trim() ||
        claims.sub.length > MAX_SUBJECT_CHARS
      ) {
        throw new Error(UNCONFIRMED)
      }
      return {
        subject: claims.sub,
        email:
          claims.email_verified === true && typeof claims.email === 'string' && claims.email.trim()
            ? claims.email
            : null
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
