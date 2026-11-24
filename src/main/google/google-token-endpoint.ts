// Google's token endpoint, called from this host only: the code exchange (with the PKCE verifier
// that never left the host) and revoke; refresh goes through the shared host login refresh. Fixed URLs; a client file's own URIs are ignored.
import { z } from 'zod'

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'

const REQUEST_TIMEOUT_MS = 15_000

export type GoogleHttp = typeof fetch
export const defaultGoogleHttp: GoogleHttp = (input, init) => fetch(input, init)

export type GoogleClientSecret = { clientId: string; clientSecret: string }

export type GoogleTokens = {
  accessToken: string
  expiresIn: number
  refreshToken?: string
  /** Space-separated scopes Google actually granted (granular consent can drop some). */
  scope?: string
  idToken?: string
}

/** Google answered, but not with tokens: `invalid_grant` means the grant is gone for good. */
export class GoogleTokenError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    description?: string
  ) {
    super(description ? `${code}: ${description}` : code)
    this.name = 'GoogleTokenError'
  }
}

async function postForm(
  http: GoogleHttp,
  url: string,
  form: Record<string, string>,
  signal?: AbortSignal
): Promise<{ status: number; ok: boolean; body: unknown }> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const response = await http(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  })
  const body: unknown = await response.json().catch(() => null)
  return { status: response.status, ok: response.ok, body }
}

const Text = z.string().min(1)
const TokenResponse = z.object({
  access_token: Text,
  expires_in: z.number().positive(),
  refresh_token: Text.optional(),
  scope: Text.optional(),
  id_token: Text.optional()
})
const TokenErrorResponse = z.object({ error: Text, error_description: z.string().optional() })
const IdTokenClaims = z.object({
  sub: Text,
  email: Text,
  email_verified: z.boolean().optional()
})

function readTokens(status: number, ok: boolean, body: unknown): GoogleTokens {
  const tokens = ok ? TokenResponse.safeParse(body).data : undefined
  if (!tokens) {
    const refused = TokenErrorResponse.safeParse(body).data
    throw new GoogleTokenError(
      refused?.error ?? `http_${status}`,
      status,
      refused?.error_description
    )
  }
  return {
    accessToken: tokens.access_token,
    expiresIn: tokens.expires_in,
    ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    ...(tokens.scope ? { scope: tokens.scope } : {}),
    ...(tokens.id_token ? { idToken: tokens.id_token } : {})
  }
}

export async function exchangeGoogleCode(
  http: GoogleHttp,
  client: GoogleClientSecret,
  args: { code: string; codeVerifier: string; redirectUri: string },
  signal?: AbortSignal
): Promise<GoogleTokens> {
  const { status, ok, body } = await postForm(
    http,
    GOOGLE_TOKEN_URL,
    {
      grant_type: 'authorization_code',
      code: args.code,
      code_verifier: args.codeVerifier,
      redirect_uri: args.redirectUri,
      client_id: client.clientId,
      client_secret: client.clientSecret
    },
    signal
  )
  return readTokens(status, ok, body)
}

/** Cancels the grant at Google; true when Google confirmed or already had none. */
export async function revokeGoogleToken(http: GoogleHttp, token: string): Promise<boolean> {
  const { ok, body } = await postForm(http, GOOGLE_REVOKE_URL, { token })
  return ok || TokenErrorResponse.safeParse(body).data?.error === 'invalid_token'
}

/**
 * The signed-in account (Google's stable id, and the address shown) from the id token Google's
 * token endpoint just returned over TLS to this host, which OpenID Connect lets a client trust
 * without checking the signature.
 */
export function accountFromIdToken(
  idToken: string | undefined
): { sub: string; email: string } | null {
  const payload = idToken?.split('.')[1]
  if (!payload) {
    return null
  }
  try {
    const claims = IdTokenClaims.safeParse(
      JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'))
    ).data
    return claims && claims.email.includes('@') && claims.email_verified !== false
      ? { sub: claims.sub, email: claims.email.toLowerCase() }
      : null
  } catch {
    return null
  }
}
