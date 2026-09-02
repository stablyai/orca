import { readFile, writeFile, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { net } from 'electron'
import { extractOAuthClientCredentials } from './gemini-cli-oauth-extractor'

const API_TIMEOUT_MS = 10_000
const OAUTH_CREDS_PATH = path.join(homedir(), '.gemini', 'oauth_creds.json')
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const LOAD_CODE_ASSIST_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist'

const CREDENTIAL_CANDIDATE_PATHS = [
  path.join(homedir(), '.gemini', 'antigravity-cli', 'oauth_creds.json'),
  path.join(homedir(), '.gemini', 'antigravity-cli', 'credentials.json'),
  path.join(homedir(), '.gemini', 'antigravity-cli', 'auth.json'),
  path.join(homedir(), '.gemini', 'config', 'oauth_creds.json'),
  path.join(homedir(), '.gemini', 'config', 'credentials.json'),
  path.join(homedir(), '.gemini', 'config', 'auth.json'),
  path.join(homedir(), '.gemini', 'oauth_creds.json'),
  path.join(homedir(), '.gemini', 'credentials.json'),
  path.join(homedir(), '.gemini', 'auth.json')
]

let lastActiveCredsPath = OAUTH_CREDS_PATH

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

export async function readAuthJson(): Promise<AuthJson | null> {
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
      const raw = await readFile(candidate, 'utf-8')
      return JSON.parse(raw) as AuthJson
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        continue
      }
      throw err
    }
  }

  return null
}

function parseCredentialsObject(parsed: unknown): GeminiCredentials | null {
  if (!parsed || typeof parsed !== 'object') {
    return null
  }
  const obj = parsed as Record<string, unknown>
  const creds =
    (obj.google && typeof obj.google === 'object'
      ? (obj.google as Record<string, unknown>)
      : null) ??
    (obj.oauth && typeof obj.oauth === 'object'
      ? (obj.oauth as Record<string, unknown>)
      : null) ??
    (obj.credentials && typeof obj.credentials === 'object'
      ? (obj.credentials as Record<string, unknown>)
      : null) ??
    obj

  const accessToken =
    typeof creds.access_token === 'string'
      ? creds.access_token
      : typeof creds.accessToken === 'string'
        ? creds.accessToken
        : typeof creds.access === 'string'
          ? creds.access
          : null

  const refreshToken =
    typeof creds.refresh_token === 'string'
      ? creds.refresh_token
      : typeof creds.refreshToken === 'string'
        ? creds.refreshToken
        : typeof creds.refresh === 'string'
          ? creds.refresh
          : null

  if (!accessToken || !refreshToken) {
    return null
  }

  let expiryDate: number
  if (typeof creds.expiry_date === 'number') {
    expiryDate = creds.expiry_date
  } else if (typeof creds.expiryDate === 'number') {
    expiryDate = creds.expiryDate
  } else if (typeof creds.expiresAt === 'number') {
    expiryDate = creds.expiresAt
  } else if (typeof creds.expires === 'number') {
    expiryDate = creds.expires
  } else if (typeof creds.expires_in === 'number') {
    expiryDate = Date.now() + creds.expires_in * 1000
  } else if (typeof creds.expiresIn === 'number') {
    expiryDate = Date.now() + creds.expiresIn * 1000
  } else {
    expiryDate = 0
  }

  return { access_token: accessToken, refresh_token: refreshToken, expiry_date: expiryDate }
}

export async function readGeminiCredentials(): Promise<GeminiCredentials | null> {
  for (const candidatePath of CREDENTIAL_CANDIDATE_PATHS) {
    try {
      const raw = await readFile(candidatePath, 'utf-8')
      const parsed = JSON.parse(raw) as unknown
      const creds = parseCredentialsObject(parsed)
      if (creds) {
        lastActiveCredsPath = candidatePath
        return creds
      }
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        continue
      }
      // malformed file or other error — try next candidate
    }
  }
  return null
}

export async function saveGeminiCredentials(creds: GeminiCredentials): Promise<void> {
  const targetPath = lastActiveCredsPath || OAUTH_CREDS_PATH
  const tmpPath = `${targetPath}.${process.pid}.tmp`
  await writeFile(tmpPath, JSON.stringify(creds, null, 2), 'utf-8')
  await rename(tmpPath, targetPath)
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

async function tryReadLocalProjectId(): Promise<string | null> {
  const projectCandidates = [
    path.join(homedir(), '.gemini', 'antigravity-cli', 'cache', 'default_project_id.txt'),
    path.join(homedir(), '.gemini', 'config', 'projects', 'default-cli-project.json'),
    path.join(homedir(), '.gemini', 'projects.json')
  ]

  for (const candidate of projectCandidates) {
    try {
      const raw = (await readFile(candidate, 'utf-8')).trim()
      if (!raw) {
        continue
      }
      if (candidate.endsWith('.json')) {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        const projectId =
          (typeof parsed.projectId === 'string' && parsed.projectId) ||
          (typeof parsed.cloudaicompanionProject === 'string' && parsed.cloudaicompanionProject) ||
          (typeof parsed.defaultProject === 'string' && parsed.defaultProject) ||
          (typeof parsed.id === 'string' && parsed.id) ||
          null
        if (projectId) {
          return projectId
        }
      } else {
        return raw
      }
    } catch {
      // ignore ENOENT / parse error
    }
  }
  return null
}

export async function loadProjectId(accessToken: string): Promise<string> {
  // Try Antigravity first, fallback to Gemini CLI metadata
  const metadataVariants = [
    { ideType: 'ANTIGRAVITY', pluginType: 'ANTIGRAVITY' },
    { ideType: 'GEMINI_CLI', pluginType: 'GEMINI' }
  ]

  for (const metadata of metadataVariants) {
    try {
      const res = await net.fetch(LOAD_CODE_ASSIST_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify({ metadata }),
        signal: AbortSignal.timeout(API_TIMEOUT_MS)
      })

      if (res.ok) {
        const data = (await res.json()) as { cloudaicompanionProject?: string }
        if (typeof data.cloudaicompanionProject === 'string' && data.cloudaicompanionProject) {
          return data.cloudaicompanionProject
        }
      }
    } catch {
      // try next variant
    }
  }

  const localProject = await tryReadLocalProjectId()
  if (localProject) {
    return localProject
  }

  throw new Error('Gemini project ID not found in API response')
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
