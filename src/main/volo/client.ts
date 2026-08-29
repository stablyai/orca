import { CredentialDecryptionError } from '../integration-credential-file'
import type {
  VoloConnectArgs,
  VoloConnectResult,
  VoloConnectionStatus,
  VoloGoogleLoginResult,
  VoloViewer
} from '../../shared/volo-types'
import {
  applyVoloRefreshTokens,
  sessionAccessExpired,
  type VoloGoogleSession
} from '../../shared/volo-google-session'
import { DEFAULT_VOLO_API_URL, deriveVoloWebUrl, normalizeVoloApiUrl } from '../../shared/volo-urls'
import { isVoloAuthError, refreshVoloAccessTokens, voloRequest } from './authenticated-request'
import {
  clearConnection,
  credentialError,
  hasSavedLocalCredentials,
  hasStoredToken,
  persistGoogleSession,
  readConnection,
  readSavedLocalGoogleSession,
  readSession,
  readToken,
  saveToken,
  writeConnection
} from './credential-store'
import { beginVoloGoogleCliLogin } from './google-login'
import { mapVoloViewer } from './mapping'

export function getStatus(): VoloConnectionStatus {
  const connection = readConnection()
  if (!connection || !hasStoredToken()) {
    return {
      connected: false,
      viewer: null,
      hasSavedLocalCredentials: hasSavedLocalCredentials()
    }
  }
  return {
    connected: true,
    viewer: connection.viewer,
    apiUrl: connection.apiUrl,
    webUrl: connection.webUrl,
    hasSavedLocalCredentials: hasSavedLocalCredentials(),
    ...(credentialError ? { credentialError } : {})
  }
}

export function getActiveCredentials(): { apiUrl: string; webUrl: string; token: string } | null {
  const connection = readConnection()
  if (!connection) {
    return null
  }
  const token = readToken()
  if (!token) {
    return null
  }
  return { apiUrl: connection.apiUrl, webUrl: connection.webUrl, token }
}

function loadGoogleSession(): VoloGoogleSession | null {
  return readSavedLocalGoogleSession() ?? readSession()
}

async function refreshSessionIfNeeded(
  apiUrl: string,
  session: VoloGoogleSession
): Promise<VoloGoogleSession> {
  if (!sessionAccessExpired(session) || !session.refreshToken) {
    return session
  }
  const tokens = await refreshVoloAccessTokens(apiUrl, session.refreshToken)
  const next = applyVoloRefreshTokens(session, tokens)
  persistGoogleSession(next)
  return next
}

export async function ensureActiveCredentials(): Promise<{
  apiUrl: string
  webUrl: string
  token: string
} | null> {
  const connection = readConnection()
  if (!connection) {
    return null
  }
  const session = loadGoogleSession()
  if (!session?.accessToken) {
    return null
  }
  try {
    const fresh = await refreshSessionIfNeeded(connection.apiUrl, session)
    return { apiUrl: connection.apiUrl, webUrl: connection.webUrl, token: fresh.accessToken }
  } catch {
    return { apiUrl: connection.apiUrl, webUrl: connection.webUrl, token: session.accessToken }
  }
}

async function fetchViewer(apiUrl: string, token: string): Promise<VoloViewer> {
  try {
    return mapVoloViewer(await voloRequest(apiUrl, token, '/api/auth/me'), 'Volo user')
  } catch (error) {
    if (!isVoloAuthError(error) || !token.startsWith('jk_')) {
      throw error
    }
    // API tokens cannot call /api/auth/me; listing boards is the connect probe.
    await voloRequest(apiUrl, token, '/api/tasks/boards')
    return { id: 'api-token', displayName: 'Volo API token', email: null }
  }
}

export async function connect(args: VoloConnectArgs): Promise<VoloConnectResult> {
  const apiToken = args.apiToken.trim()
  if (!apiToken) {
    return { ok: false, error: 'API token is required.' }
  }
  let apiUrl: string
  try {
    apiUrl = normalizeVoloApiUrl(args.apiUrl?.trim() || DEFAULT_VOLO_API_URL)
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Enter a valid Volo API URL.'
    }
  }
  const webUrl = args.webUrl?.trim() || deriveVoloWebUrl(apiUrl)
  try {
    const viewer = await fetchViewer(apiUrl, apiToken)
    saveToken(apiToken)
    writeConnection({ version: 1, apiUrl, webUrl, viewer })
    return { ok: true, viewer }
  } catch (error) {
    if (error instanceof CredentialDecryptionError) {
      return { ok: false, error: error.message }
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not connect to Volo.'
    }
  }
}

async function connectGoogleSession(
  session: VoloGoogleSession,
  apiUrl: string
): Promise<VoloGoogleLoginResult> {
  let fresh = session
  try {
    fresh = await refreshSessionIfNeeded(apiUrl, session)
  } catch (error) {
    if (!session.accessToken) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Could not refresh the Volo Google session.'
      }
    }
  }
  persistGoogleSession(fresh)
  const result = await connect({ apiToken: fresh.accessToken, apiUrl })
  if (!result.ok) {
    return result
  }
  return { ok: true, viewer: result.viewer, apiToken: fresh.accessToken, apiUrl }
}

export async function connectFromSavedCredentials(): Promise<VoloConnectResult> {
  const session = loadGoogleSession()
  if (!session?.accessToken && !session?.refreshToken) {
    return { ok: false, error: 'No saved Volo Google session was found.' }
  }
  return connectGoogleSession(session, DEFAULT_VOLO_API_URL)
}

let googleLoginInFlight: Promise<VoloGoogleLoginResult> | null = null

export async function loginWithGoogle(apiUrlInput?: string): Promise<VoloGoogleLoginResult> {
  if (googleLoginInFlight) {
    return googleLoginInFlight
  }
  googleLoginInFlight = loginWithGoogleOnce(apiUrlInput).finally(() => {
    googleLoginInFlight = null
  })
  return googleLoginInFlight
}

async function loginWithGoogleOnce(apiUrlInput?: string): Promise<VoloGoogleLoginResult> {
  let apiUrl: string
  try {
    apiUrl = normalizeVoloApiUrl(apiUrlInput?.trim() || DEFAULT_VOLO_API_URL)
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Enter a valid Volo API URL.'
    }
  }
  const existing = loadGoogleSession()
  if (existing?.accessToken || existing?.refreshToken) {
    const reused = await connectGoogleSession(existing, apiUrl)
    if (reused.ok || !isLikelyExpiredGoogleSession(reused)) {
      return reused
    }
  }
  try {
    const session = await beginVoloGoogleCliLogin(apiUrl)
    return await connectGoogleSession(session, apiUrl)
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not sign in to Volo with Google.'
    }
  }
}

function isLikelyExpiredGoogleSession(result: VoloGoogleLoginResult): boolean {
  if (result.ok) {
    return false
  }
  return /unauthorized|expired|invalid token|not provided/i.test(result.error)
}

export async function testConnection(): Promise<VoloConnectResult> {
  const credentials = await ensureActiveCredentials()
  if (!credentials) {
    return { ok: false, error: 'Volo is not connected.' }
  }
  try {
    const viewer = await fetchViewer(credentials.apiUrl, credentials.token)
    writeConnection({
      version: 1,
      apiUrl: credentials.apiUrl,
      webUrl: credentials.webUrl,
      viewer
    })
    return { ok: true, viewer }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not verify the Volo connection.'
    }
  }
}

export function disconnect(): { ok: true } {
  clearConnection()
  return { ok: true }
}
