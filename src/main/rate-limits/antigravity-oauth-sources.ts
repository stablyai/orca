import { readFile, writeFile, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { net } from 'electron'
import { runProcess } from '../../shared/child-process/run-process'
import { extractOAuthClientCredentials } from './gemini-cli-oauth-extractor'

const API_TIMEOUT_MS = 10_000
const PRIMARY_OAUTH_CREDS_PATH = path.join(homedir(), '.gemini', 'oauth_creds.json')
const FALLBACK_OAUTH_CREDS_PATH = path.join(homedir(), '.antigravity', 'oauth_creds.json')
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const LOAD_CODE_ASSIST_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist'

// Why: cloudcode-pa rejects requests whose User-Agent is not an Antigravity
// client with 403 PERMISSION_DENIED (the same contract the `agy` CLI and
// sub2api follow). The platform segment is not validated, so we report the
// truthful one.
export const ANTIGRAVITY_USER_AGENT = `antigravity/2.9.1 ${process.platform}/${process.arch}`

export type AntigravityCredentials = {
  access_token: string
  refresh_token: string
  expiry_date: number
  credsFilePath?: string
  // Why: tokens minted by the `agy` CLI live in the OS keychain and are bound
  // to the Antigravity OAuth client — Orca can read them but cannot refresh
  // them (the refresh would need agy's embedded client secret). The CLI
  // refreshes them on its own, so Orca just re-reads on every poll.
  source?: 'keychain' | 'file'
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
          credsFilePath: credPath,
          source: 'file'
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

// Why: the `agy` CLI (Go) stores its OAuth token via go-keyring. On macOS that
// is a generic-password item with service "gemini" and account "antigravity",
// whose data is the literal prefix "go-keyring-base64:" followed by base64 of
// {"token":{"access_token":...,"refresh_token":...,"expiry":RFC3339}}.
// This is the freshest working credential on a machine with agy installed —
// the legacy ~/.gemini/oauth_creds.json token was minted by the retired
// Gemini CLI client and gets 403 SUBSCRIPTION_REQUIRED from cloudcode-pa.
export async function readAntigravityKeychainCredentials(): Promise<AntigravityCredentials | null> {
  if (process.platform !== 'darwin') {
    return null
  }
  try {
    const result = await runProcess({
      program: '/usr/bin/security',
      args: ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w'],
      timeoutMs: API_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024
    })
    if (result.code !== 0) {
      return null
    }
    const raw = result.stdout.trim()
    if (!raw.startsWith('go-keyring-base64:')) {
      return null
    }
    const decoded = JSON.parse(
      Buffer.from(raw.slice('go-keyring-base64:'.length), 'base64').toString('utf-8')
    ) as {
      token?: { access_token?: unknown; refresh_token?: unknown; expiry?: unknown }
    }
    const token = decoded.token
    if (
      !token ||
      typeof token.access_token !== 'string' ||
      typeof token.refresh_token !== 'string' ||
      !token.access_token ||
      !token.refresh_token
    ) {
      return null
    }
    const expiryMs = typeof token.expiry === 'string' ? Date.parse(token.expiry) : Number.NaN
    return {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expiry_date: Number.isFinite(expiryMs) ? expiryMs : 0,
      source: 'keychain'
    }
  } catch {
    // Missing item, keychain locked, or user denied access — fall through.
    return null
  }
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
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': ANTIGRAVITY_USER_AGENT
      },
      body: JSON.stringify({
        metadata: { ideType: 'ANTIGRAVITY', ideName: 'antigravity', ideVersion: '2.9.1' }
      }),
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

  // Why: the agy CLI caches its resolved default project on disk; it is the
  // most accurate local fallback because it reflects the signed-in account.
  try {
    const cached = (
      await readFile(
        path.join(homedir(), '.gemini', 'antigravity-cli', 'cache', 'default_project_id.txt'),
        'utf-8'
      )
    ).trim()
    if (cached) {
      return cached
    }
  } catch {
    // ignore
  }

  // Why: mirrors the constant embedded in the agy binary — the server accepts
  // this synthetic project for personal-tier accounts.
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
