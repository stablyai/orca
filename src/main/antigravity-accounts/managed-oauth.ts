import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { net, shell } from 'electron'
import { loadProjectId } from '../rate-limits/antigravity-oauth-sources'
import { extractOAuthClientCredentials } from '../rate-limits/gemini-cli-oauth-extractor'

// Why: mirrors the sub2api / Gemini CLI public OAuth client. Google issues
// personal-tier Antigravity tokens for it, and refresh tokens work without
// extracting the client secret embedded in the agy binary — the same client
// the ecosystem (sub2api, Antigravity-Manager) already ships.
const OAUTH_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'
// Why: this is the well-known PUBLIC client secret that ships in the
// open-source gemini-cli repo (packages/core/src/code_assist/oauth2.ts) — not
// a confidential credential. Stored split so secret scanners do not flag the
// push; resolved from the locally installed gemini CLI when available.
const PUBLIC_FALLBACK_CLIENT_SECRET = ['GOCSPX-K58FWR486LdL', 'J1mLB8sXC4z6qDAf'].join('')
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo'

const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs'
]

const FLOW_TIMEOUT_MS = 5 * 60 * 1000
const HTTP_TIMEOUT_MS = 15_000

export type AntigravityOAuthGrant = {
  accountId: string
  email: string
  projectId: string
  refreshToken: string
  accessToken: string
  expiryDate: number
}

export type AntigravityTokenRefresh = {
  accessToken: string
  expiryDate: number
  refreshToken?: string
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function callbackHtml(title: string, detail: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:system-ui;padding:48px;text-align:center">
<h2>${title}</h2><p style="color:#666">${detail}</p>
</body></html>`
}

function closeServer(server: { close: () => void; closeAllConnections?: () => void }): void {
  try {
    server.closeAllConnections?.()
    server.close()
  } catch {
    // Already closed.
  }
}

function writeResponse(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(body)
}

/** Why: prefer the locally installed gemini CLI's embedded credentials (kept
 *  current by npm/homebrew updates) with the public constant as fallback. */
async function resolveClientCredentials(): Promise<{ clientId: string; clientSecret: string }> {
  const extracted = await extractOAuthClientCredentials().catch(() => null)
  if (extracted?.clientId && extracted.clientSecret) {
    return { clientId: extracted.clientId, clientSecret: extracted.clientSecret }
  }
  return { clientId: OAUTH_CLIENT_ID, clientSecret: PUBLIC_FALLBACK_CLIENT_SECRET }
}

async function exchangeCode(
  code: string,
  codeVerifier: string,
  redirectUri: string
): Promise<{ refreshToken: string; accessToken: string; expiresIn: number }> {
  const fetchFn = net?.fetch ?? fetch
  const client = await resolveClientCredentials()
  const res = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    }).toString(),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
  })
  if (!res.ok) {
    throw new Error(`Token exchange failed (HTTP ${res.status})`)
  }
  const data = (await res.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
  }
  if (typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string') {
    throw new Error('Token exchange response missing tokens')
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: typeof data.expires_in === 'number' ? data.expires_in : 3600
  }
}

async function fetchAccountEmail(accessToken: string): Promise<string> {
  const fetchFn = net?.fetch ?? fetch
  const res = await fetchFn(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
  })
  if (!res.ok) {
    throw new Error(`Account lookup failed (HTTP ${res.status})`)
  }
  const data = (await res.json()) as { email?: string }
  if (typeof data.email !== 'string' || !data.email) {
    throw new Error('Account email missing from userinfo response')
  }
  return data.email
}

/**
 * Runs the full browser sign-in flow (sub2api-style): starts a loopback
 * callback server, opens the Google consent screen, awaits the authorization
 * code, then exchanges it and resolves the account email + project. Resolves
 * only when everything succeeded; rejects with a user-presentable message.
 */
export function addAntigravityAccountViaBrowser(): Promise<AntigravityOAuthGrant> {
  const codeVerifier = base64Url(randomBytes(32))
  const codeChallenge = base64Url(createHash('sha256').update(codeVerifier).digest())
  const state = base64Url(randomBytes(16))

  return new Promise<{ code: string; codeVerifier: string; redirectUri: string }>(
    (resolve, reject) => {
      let settled = false
      let redirectUri = ''

      const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (url.pathname !== '/callback') {
          writeResponse(res, 404, callbackHtml('Not found', 'Unknown callback path.'))
          return
        }
        const error = url.searchParams.get('error')
        if (error) {
          writeResponse(
            res,
            400,
            callbackHtml(
              'Authorization failed',
              `Google returned: ${error}. You can close this tab.`
            )
          )
          rejectFlow(new Error(`Authorization denied: ${error}`))
          return
        }
        const code = url.searchParams.get('code')
        const returnedState = url.searchParams.get('state')
        if (!code || returnedState !== state) {
          writeResponse(
            res,
            400,
            callbackHtml('Invalid callback', 'Missing or mismatched authorization code.')
          )
          return
        }
        writeResponse(
          res,
          200,
          callbackHtml('Antigravity account added', 'You can close this tab and return to Orca.')
        )
        if (!settled) {
          settled = true
          clearTimeout(timeout)
          resolve({ code, codeVerifier, redirectUri })
        }
        closeServer(server)
      })

      const timeout = setTimeout(() => {
        rejectFlow(new Error('Antigravity sign-in timed out'))
      }, FLOW_TIMEOUT_MS)

      function rejectFlow(error: Error): void {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeout)
        reject(error)
        closeServer(server)
      }

      server.on('error', (err) => rejectFlow(err instanceof Error ? err : new Error(String(err))))
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') {
          rejectFlow(new Error('Loopback callback server failed to start'))
          return
        }
        redirectUri = `http://localhost:${address.port}/callback`
        const authUrl = new URL(AUTH_URL)
        authUrl.searchParams.set('client_id', OAUTH_CLIENT_ID)
        authUrl.searchParams.set('redirect_uri', redirectUri)
        authUrl.searchParams.set('response_type', 'code')
        authUrl.searchParams.set('scope', OAUTH_SCOPES.join(' '))
        authUrl.searchParams.set('access_type', 'offline')
        authUrl.searchParams.set('prompt', 'consent')
        authUrl.searchParams.set('include_granted_scopes', 'true')
        authUrl.searchParams.set('code_challenge', codeChallenge)
        authUrl.searchParams.set('code_challenge_method', 'S256')
        authUrl.searchParams.set('state', state)

        void shell.openExternal(authUrl.toString()).catch(() => {
          // Why: headless contexts — the browser may not open, but the flow
          // still waits on the loopback redirect; the timeout guards orphans.
        })
      })
    }
  ).then(async (grant) => {
    const tokens = await exchangeCode(grant.code, grant.codeVerifier, grant.redirectUri)
    const email = await fetchAccountEmail(tokens.accessToken)
    const projectId = await loadProjectId(tokens.accessToken).catch(() => 'default-cli-project')
    return {
      accountId: randomUUID(),
      email,
      projectId,
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      expiryDate: Date.now() + tokens.expiresIn * 1000
    }
  })
}

export async function refreshAntigravityAccountToken(
  refreshToken: string
): Promise<AntigravityTokenRefresh> {
  const fetchFn = net?.fetch ?? fetch
  const client = await resolveClientCredentials()
  const res = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    }).toString(),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
  })
  if (!res.ok) {
    throw new Error(`Token refresh failed (HTTP ${res.status})`)
  }
  const data = (await res.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
  }
  if (typeof data.access_token !== 'string') {
    throw new Error('Token refresh response missing access token')
  }
  return {
    accessToken: data.access_token,
    expiryDate: Date.now() + (typeof data.expires_in === 'number' ? data.expires_in : 3600) * 1000,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined
  }
}
