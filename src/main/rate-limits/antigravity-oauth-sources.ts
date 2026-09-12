import { readFile, writeFile, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { net } from 'electron'
import { extractOAuthClientCredentials } from './gemini-cli-oauth-extractor'

const API_TIMEOUT_MS = 10_000
const PRIMARY_OAUTH_CREDS_PATH = path.join(homedir(), '.gemini', 'oauth_creds.json')
const FALLBACK_OAUTH_CREDS_PATH = path.join(homedir(), '.antigravity', 'oauth_creds.json')
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const LOAD_CODE_ASSIST_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist'

export type AntigravityCredentials = {
  access_token: string
  refresh_token: string
  expiry_date: number
  credsFilePath?: string
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

export async function readAntigravityCredentials(): Promise<AntigravityCredentials | null> {
  const candidates = [PRIMARY_OAUTH_CREDS_PATH, FALLBACK_OAUTH_CREDS_PATH]
  for (const credPath of candidates) {
    try {
      const raw = await readFile(credPath, 'utf-8')
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
        return {
          access_token: parsed.access_token,
          refresh_token: parsed.refresh_token,
          expiry_date: parsed.expiry_date,
          credsFilePath: credPath
        }
      }
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        continue
      }
      throw err
    }
  }
  return null
}

export async function saveAntigravityCredentials(creds: AntigravityCredentials): Promise<void> {
  const targetPath = creds.credsFilePath || PRIMARY_OAUTH_CREDS_PATH
  const tmpPath = `${targetPath}.${process.pid}.tmp`
  const { credsFilePath: _ignored, ...dataToSave } = creds
  await writeFile(tmpPath, JSON.stringify(dataToSave, null, 2), 'utf-8')
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
  const fetchFn = net?.fetch ?? fetch
  const res = await fetchFn(GOOGLE_TOKEN_URL, {
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
  const fetchFn = net?.fetch ?? fetch
  try {
    const res = await fetchFn(LOAD_CODE_ASSIST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS)
    })

    if (res.ok) {
      const data = (await res.json()) as { cloudaicompanionProject?: string }
      if (typeof data.cloudaicompanionProject === 'string' && data.cloudaicompanionProject) {
        return data.cloudaicompanionProject
      }
    }
  } catch {
    // continue to local fallback
  }

  // Fallback to reading projects.json
  const projectPaths = [
    path.join(homedir(), '.gemini', 'projects.json'),
    path.join(homedir(), '.antigravity', 'projects.json')
  ]
  for (const projPath of projectPaths) {
    try {
      const raw = await readFile(projPath, 'utf-8')
      const parsed = JSON.parse(raw) as { projects?: Record<string, string> }
      if (parsed.projects && typeof parsed.projects === 'object') {
        const firstProject = Object.values(parsed.projects)[0]
        if (firstProject && typeof firstProject === 'string') {
          return firstProject
        }
      }
    } catch {
      // ignore
    }
  }

  return 'default-cli-project'
}

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
