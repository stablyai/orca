// chatgpt.com refuses Cloudflare Workers' egress (a 403 "Unable to load site" page), so
// the egress proxy sends its chatgpt.com requests through the ChatGPT relay on Cloud Run
// (cloud/apps/chatgpt-relay), which ChatGPT answers. The Worker still decides everything: which
// credential, which paths. The relay pins the paths again and only ever talks to chatgpt.com.
// Auth: Cloud Run IAM. The Worker signs in as one service account that holds only run.invoker on the
// relay, and sends a Google ID token for the relay's URL in X-Serverless-Authorization, so the
// request's own Authorization (the ChatGPT token) passes through untouched.
//   CHATGPT_RELAY_URL              https://<service>.run.app (unset: chatgpt.com directly, as before)
//   CHATGPT_RELAY_SERVICE_ACCOUNT  (secret) service-account JSON with run.invoker on that service only
import { SignJWT, importPKCS8 } from 'jose'
import { z } from 'zod'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const RELAYED_HOSTS: ReadonlySet<string> = new Set(['chatgpt.com'])
const ServiceAccount = z.looseObject({ client_email: z.string().min(3).max(320), private_key: z.string().min(100) })
const IdTokenResponse = z.looseObject({ id_token: z.string().min(20) })

export class RelayAuthError extends Error {}

/** A Google ID token for `audience`, minted from the service account, cached until 5 minutes before expiry. */
export function createIdTokenSource(config: { serviceAccountJson: string; audience: string; fetch?: typeof fetch; now?: () => number }) {
  const doFetch = config.fetch ?? fetch
  const now = config.now ?? Date.now
  let cached: { value: string; expiresAt: number } | null = null
  let signingKey: CryptoKey | null = null
  async function mint(): Promise<string> {
    let account: z.infer<typeof ServiceAccount>
    try {
      account = ServiceAccount.parse(JSON.parse(config.serviceAccountJson))
      signingKey ??= await importPKCS8(account.private_key, 'RS256')
    } catch {
      throw new RelayAuthError('relay service account is malformed')
    }
    const iat = Math.floor(now() / 1000) - 30
    const assertion = await new SignJWT({ target_audience: config.audience })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(account.client_email)
      .setSubject(account.client_email)
      .setAudience(TOKEN_URL)
      .setIssuedAt(iat)
      .setExpirationTime(iat + 600)
      .sign(signingKey)
    const response = await doFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      signal: AbortSignal.timeout(10_000)
    })
    const parsed = IdTokenResponse.safeParse(await response.json().catch(() => null))
    if (!response.ok || !parsed.success) {
      throw new RelayAuthError(`relay id token mint failed (${response.status})`)
    }
    // Google ID tokens last an hour; read exp rather than assume it.
    const payload = JSON.parse(atob(parsed.data.id_token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number }
    cached = { value: parsed.data.id_token, expiresAt: (payload.exp ?? Math.floor(now() / 1000) + 3600) * 1000 }
    return cached.value
  }
  return async (): Promise<string> => {
    if (cached && cached.expiresAt - now() > 5 * 60_000) {
      return cached.value
    }
    // Each request mints for itself: an in-flight mint shared across requests hangs them all if its own request
    // is cancelled (settled-cache.ts). The value, once minted, is shared.
    return mint()
  }
}

/**
 * The egress proxy's upstream fetch: chatgpt.com through the relay when one is configured, every other host
 * (and chatgpt.com without a relay) directly. Same request, same path and query; only the origin changes.
 */
export function relayingFetch(config: { relayUrl?: string; idToken?: () => Promise<string>; fetch?: typeof fetch }): typeof fetch {
  const doFetch = config.fetch ?? fetch
  const relay = config.relayUrl ? new URL(config.relayUrl) : null
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (!relay || !config.idToken || target.protocol !== 'https:' || !RELAYED_HOSTS.has(target.hostname)) {
      return doFetch(input, init)
    }
    let idToken: string
    try {
      idToken = await config.idToken()
    } catch {
      // In ChatGPT's error shape (a JSON detail), so Codex prints it instead of retrying a bare 5xx.
      console.error(JSON.stringify({ event: 'chatgpt_relay_auth_failed' }))
      return Response.json({ detail: 'Orca Cloud couldn’t reach ChatGPT just now. Try again in a minute.' }, { status: 503 })
    }
    const headers = new Headers(init?.headers)
    headers.set('x-serverless-authorization', `Bearer ${idToken}`)
    return doFetch(`${relay.origin}${target.pathname}${target.search}`, { ...init, headers })
  }) as typeof fetch
}
