import { execSync } from 'node:child_process'
import { readdirSync, type Dirent } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { net } from 'electron'

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

export async function readAuthJson(): Promise<AuthJson | null> {
  const candidates = [
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

export async function readGeminiCredentials(): Promise<GeminiCredentials | null> {
  try {
    const raw = await readFile(OAUTH_CREDS_PATH, 'utf-8')
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

function resolveGeminiBinary(): string | null {
  try {
    return execSync('which gemini', { encoding: 'utf-8' }).trim()
  } catch {
    return null
  }
}

async function extractOAuthClientCredentials(
  geminiPath: string
): Promise<{ clientId: string; clientSecret: string } | null> {
  const queue = [path.dirname(geminiPath)]
  const visited = new Set<string>()

  while (queue.length > 0) {
    const dir = queue.shift()
    if (!dir || visited.has(dir)) {
      continue
    }
    visited.add(dir)

    let entries: Dirent<string>[]
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      continue
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        queue.push(fullPath)
        continue
      }
      if (entry.name !== 'oauth2.js') {
        continue
      }
      try {
        const content = await readFile(fullPath, 'utf-8')
        const idMatch = content.match(/OAUTH_CLIENT_ID\s*=\s*['"]([^'"]+)['"]/)?.[1]
        const secretMatch = content.match(/OAUTH_CLIENT_SECRET\s*=\s*['"]([^'"]+)['"]/)?.[1]
        if (idMatch && secretMatch) {
          return { clientId: idMatch, clientSecret: secretMatch }
        }
      } catch {
        // Continue searching if this oauth2.js path is unreadable.
      }
    }
  }

  return null
}

export async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<string | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS)

  try {
    const res = await net.fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      }).toString(),
      signal: controller.signal
    })

    if (!res.ok) {
      return null
    }

    const data = (await res.json()) as { access_token?: string }
    return typeof data.access_token === 'string' ? data.access_token : null
  } finally {
    clearTimeout(timeout)
  }
}

export async function loadProjectId(accessToken: string): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS)

  try {
    const res = await net.fetch(LOAD_CODE_ASSIST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify({ metadata: { ideType: 'GEMINI_CLI', pluginType: 'GEMINI' } }),
      signal: controller.signal
    })

    if (!res.ok) {
      return ''
    }

    const data = (await res.json()) as { cloudaicompanionProject?: string }
    return typeof data.cloudaicompanionProject === 'string' ? data.cloudaicompanionProject : ''
  } finally {
    clearTimeout(timeout)
  }
}

export async function tryRefreshTokenFromBundle(creds: GeminiCredentials): Promise<string | null> {
  const geminiPath = resolveGeminiBinary()
  if (!geminiPath) {
    return null
  }

  const clientCreds = await extractOAuthClientCredentials(geminiPath)
  if (!clientCreds) {
    return null
  }

  return refreshAccessToken(creds.refresh_token, clientCreds.clientId, clientCreds.clientSecret)
}
