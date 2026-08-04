import { homedir } from 'node:os'
import path from 'node:path'
import { net } from 'electron'
import { extractOAuthClientCredentials } from './gemini-cli-oauth-extractor'
import { readSnapshotFileThroughFilesystemHost } from '../filesystem-host/filesystem-host-read-authority'
import { writeRateLimitCredentialThroughFilesystemHost } from '../filesystem-host/filesystem-host-rate-limit-client'

const API_TIMEOUT_MS = 10_000
const OAUTH_CREDS_PATH = path.join(homedir(), '.gemini', 'oauth_creds.json')
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const LOAD_CODE_ASSIST_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist'

export type GeminiCredentials = {
  access_token: string
  refresh_token: string
  expiry_date: number
}

export type GoogleAuthEntry = {
  type: 'oauth'
  access: string
  expires: number
  refresh: string
}

export type AuthJson = {
  google?: GoogleAuthEntry
  'opencode-go'?: { type: 'api'; key: string }
}

export type AuthJsonSource = { path: string; value: AuthJson }

export async function readAuthJsonSource(): Promise<AuthJsonSource | null> {
  const candidates = [
    process.env.APPDATA ? path.join(process.env.APPDATA, 'opencode', 'auth.json') : null,
    process.env.XDG_DATA_HOME
      ? path.join(process.env.XDG_DATA_HOME, 'opencode', 'auth.json')
      : null,
    path.join(homedir(), '.local', 'share', 'opencode', 'auth.json'),
    path.join(homedir(), 'Library', 'Application Support', 'opencode', 'auth.json')
  ].filter((candidate): candidate is string => candidate !== null)

  for (const candidate of candidates) {
    try {
      const raw = (await readSnapshotFileThroughFilesystemHost(candidate, 'gemini-auth')).toString(
        'utf8'
      )
      const parsed = JSON.parse(raw) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null
      }
      return { path: candidate, value: parsed as AuthJson }
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        continue
      }
      throw err
    }
  }

  return null
}

export async function readGeminiCredentials(): Promise<GeminiCredentials | null> {
  try {
    const raw = (
      await readSnapshotFileThroughFilesystemHost(OAUTH_CREDS_PATH, 'gemini-oauth-credentials')
    ).toString('utf8')
    const parsed = JSON.parse(raw) as unknown
    if (
      parsed &&
      typeof parsed === 'object' &&
      'access_token' in parsed &&
      typeof parsed.access_token === 'string' &&
      'refresh_token' in parsed &&
      typeof parsed.refresh_token === 'string' &&
      'expiry_date' in parsed &&
      typeof parsed.expiry_date === 'number'
    ) {
      return parsed as GeminiCredentials
    }
    return null
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return null
    }
    throw err
  }
}

export async function saveGeminiCredentials(creds: GeminiCredentials): Promise<void> {
  await writeRateLimitCredentialThroughFilesystemHost(
    OAUTH_CREDS_PATH,
    'gemini-oauth-credentials',
    JSON.stringify(creds, null, 2)
  )
}

export async function saveAuthJsonSource(source: AuthJsonSource): Promise<void> {
  const raw = await readSnapshotFileThroughFilesystemHost(source.path, 'gemini-auth')
  const latest = JSON.parse(raw.toString('utf8')) as unknown
  if (!latest || typeof latest !== 'object' || Array.isArray(latest)) {
    throw new Error('OpenCode auth.json must contain a JSON object')
  }
  await writeRateLimitCredentialThroughFilesystemHost(
    source.path,
    'opencode-auth',
    JSON.stringify({ ...(latest as AuthJson), google: source.value.google }, null, 2)
  )
}

export type RefreshTokenResult = {
  accessToken: string | null
  newRefreshToken: string | null
  expiresIn?: number
}

export async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<RefreshTokenResult> {
  const res = await net.fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    }).toString(),
    signal: AbortSignal.timeout(API_TIMEOUT_MS)
  })

  if (!res.ok) {
    return { accessToken: null, newRefreshToken: null }
  }

  const data = (await res.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
  }
  return {
    accessToken: typeof data.access_token === 'string' ? data.access_token : null,
    newRefreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : null,
    expiresIn: typeof data.expires_in === 'number' ? data.expires_in : undefined
  }
}

export async function loadProjectId(accessToken: string): Promise<string> {
  const res = await net.fetch(LOAD_CODE_ASSIST_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({ metadata: { ideType: 'GEMINI_CLI', pluginType: 'GEMINI' } }),
    signal: AbortSignal.timeout(API_TIMEOUT_MS)
  })

  if (!res.ok) {
    throw new Error(`Failed to load Gemini project ID (HTTP ${res.status})`)
  }

  const data = (await res.json()) as { cloudaicompanionProject?: string }
  if (typeof data.cloudaicompanionProject !== 'string') {
    throw new Error('Gemini project ID not found in API response')
  }
  return data.cloudaicompanionProject
}

// Why: accepts a plain refresh token string so both the oauth_creds.json path
// (GeminiCredentials) and the auth.json path (pipe-split string) can share
// the same bundle credential extraction without coupling to either struct.
export async function tryRefreshTokenFromBundle(
  refreshToken: string,
  allowCliOAuth = true
): Promise<RefreshTokenResult | null> {
  if (!allowCliOAuth) {
    return null
  }
  const clientCreds = await extractOAuthClientCredentials()
  if (!clientCreds) {
    return null
  }

  return refreshAccessToken(refreshToken, clientCreds.clientId, clientCreds.clientSecret)
}
