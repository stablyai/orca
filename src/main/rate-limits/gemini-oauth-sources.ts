import { abortSignalWithTimeout } from '../lib/abort-signal-with-timeout'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { getMainHttpClient } from '../network/http-client'
import { extractOAuthClientCredentials } from './gemini-cli-oauth-extractor'
import { writeCredentialFileAtomic } from '../integration-credential-file'

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

type AuthJson = {
  google?: GoogleAuthEntry
  'opencode-go'?: { type: 'api'; key: string }
}

export async function readAuthJson(signal?: AbortSignal): Promise<AuthJson | null> {
  signal?.throwIfAborted()
  const candidates = [
    process.env.APPDATA ? path.join(process.env.APPDATA, 'opencode', 'auth.json') : null,
    process.env.XDG_DATA_HOME
      ? path.join(process.env.XDG_DATA_HOME, 'opencode', 'auth.json')
      : null,
    path.join(homedir(), '.local', 'share', 'opencode', 'auth.json'),
    path.join(homedir(), 'Library', 'Application Support', 'opencode', 'auth.json')
  ].filter((candidate): candidate is string => candidate !== null)

  for (const candidate of candidates) {
    signal?.throwIfAborted()
    try {
      const raw = await readFile(candidate, 'utf-8')
      signal?.throwIfAborted()
      return JSON.parse(raw) as AuthJson
    } catch (err) {
      signal?.throwIfAborted()
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        continue
      }
      throw err
    }
  }

  return null
}

export async function readGeminiCredentials(
  signal?: AbortSignal
): Promise<GeminiCredentials | null> {
  try {
    signal?.throwIfAborted()
    const raw = await readFile(OAUTH_CREDS_PATH, 'utf-8')
    signal?.throwIfAborted()
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
    signal?.throwIfAborted()
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return null
    }
    throw err
  }
}

// Why an explicit owner-only mode: the rename replaces Gemini's 0600 file, and orcad runs at the
// login umask (#31125).
export async function saveGeminiCredentials(
  creds: GeminiCredentials,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  writeCredentialFileAtomic(OAUTH_CREDS_PATH, Buffer.from(JSON.stringify(creds, null, 2), 'utf-8'))
}

export type RefreshTokenResult = {
  accessToken: string | null
  newRefreshToken: string | null
  expiresIn?: number
}

export async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  signal?: AbortSignal
): Promise<RefreshTokenResult> {
  signal?.throwIfAborted()
  const res = await getMainHttpClient().fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    }).toString(),
    signal: abortSignalWithTimeout(signal, API_TIMEOUT_MS)
  })

  signal?.throwIfAborted()
  if (!res.ok) {
    return { accessToken: null, newRefreshToken: null }
  }

  const data = (await res.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
  }
  signal?.throwIfAborted()
  return {
    accessToken: typeof data.access_token === 'string' ? data.access_token : null,
    newRefreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : null,
    expiresIn: typeof data.expires_in === 'number' ? data.expires_in : undefined
  }
}

export async function loadProjectId(accessToken: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const res = await getMainHttpClient().fetch(LOAD_CODE_ASSIST_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({ metadata: { ideType: 'GEMINI_CLI', pluginType: 'GEMINI' } }),
    signal: abortSignalWithTimeout(signal, API_TIMEOUT_MS)
  })

  signal?.throwIfAborted()
  if (!res.ok) {
    throw new Error(`Failed to load Gemini project ID (HTTP ${res.status})`)
  }

  const data = (await res.json()) as { cloudaicompanionProject?: string }
  signal?.throwIfAborted()
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
  allowCliOAuth = true,
  signal?: AbortSignal
): Promise<RefreshTokenResult | null> {
  signal?.throwIfAborted()
  if (!allowCliOAuth) {
    return null
  }
  const clientCreds = await extractOAuthClientCredentials(signal)
  signal?.throwIfAborted()
  if (!clientCreds) {
    return null
  }

  return refreshAccessToken(refreshToken, clientCreds.clientId, clientCreds.clientSecret, signal)
}
