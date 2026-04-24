import { readFile } from 'node:fs/promises'
import { execSync } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'
import { net } from 'electron'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'

const API_TIMEOUT_MS = 10_000
const OAUTH_CREDS_PATH = path.join(homedir(), '.gemini', 'oauth_creds.json')
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const LOAD_CODE_ASSIST_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist'
const RETRIEVE_QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota'

type GeminiCredentials = {
  access_token: string
  refresh_token: string
  expiry_date: number
}

type QuotaBucket = {
  remainingFraction: number
  resetTime: string
  modelId: string
}

async function readGeminiCredentials(): Promise<GeminiCredentials | null> {
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
  const isWindows = process.platform === 'win32'
  const command = isWindows ? 'where gemini' : 'which gemini'
  try {
    const result = execSync(command, { encoding: 'utf-8', timeout: 5_000 })
    const trimmed = result.trim()
    return trimmed || null
  } catch {
    return null
  }
}

async function extractOAuthClientCredentials(
  geminiPath: string
): Promise<{ clientId: string; clientSecret: string } | null> {
  const candidates = [
    path.join(
      geminiPath,
      '..',
      'lib',
      'node_modules',
      '@google',
      'gemini-cli',
      'node_modules',
      '@google',
      'gemini-cli-core',
      'dist',
      'src',
      'code_assist',
      'oauth2.js'
    ),
    path.join(
      geminiPath,
      '..',
      'node_modules',
      '@google',
      'gemini-cli-core',
      'dist',
      'src',
      'code_assist',
      'oauth2.js'
    )
  ]

  for (const candidate of candidates) {
    try {
      const content = await readFile(candidate, 'utf-8')
      const idMatch = content.match(/OAUTH_CLIENT_ID\s*=\s*['"]([^'"]+)['"]/)
      const secretMatch = content.match(/OAUTH_CLIENT_SECRET\s*=\s*['"]([^'"]+)['"]/)
      if (idMatch && secretMatch) {
        return { clientId: idMatch[1], clientSecret: secretMatch[1] }
      }
    } catch {
      // continue to next candidate
    }
  }
  return null
}

async function refreshAccessToken(
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

async function loadProjectId(accessToken: string): Promise<string> {
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

function buildWindow(buckets: QuotaBucket[]): RateLimitWindow | null {
  if (buckets.length === 0) {
    return null
  }

  const chosen = buckets.reduce((min, b) => (b.remainingFraction < min.remainingFraction ? b : min))
  const usedPercent = Math.min(100, Math.max(0, Math.round((1 - chosen.remainingFraction) * 100)))

  const resetsAtTime = new Date(chosen.resetTime).getTime()
  const resetsAt = !isNaN(resetsAtTime) ? resetsAtTime : null
  const windowMinutes = resetsAt !== null ? Math.round((resetsAt - Date.now()) / 60000) : 60

  return {
    usedPercent,
    windowMinutes,
    resetsAt,
    resetDescription: null
  }
}

async function fetchQuota(accessToken: string, projectId: string): Promise<ProviderRateLimits> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS)

  try {
    const res = await net.fetch(RETRIEVE_QUOTA_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify({ project: projectId }),
      signal: controller.signal
    })

    if (!res.ok) {
      return {
        provider: 'gemini',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: `Quota fetch failed (${res.status})`,
        status: 'error'
      }
    }

    const data = (await res.json()) as unknown
    const buckets = Array.isArray(data) ? (data as QuotaBucket[]) : []

    const proBuckets = buckets.filter(
      (b) => typeof b.modelId === 'string' && b.modelId.toLowerCase().includes('pro')
    )
    const flashBuckets = buckets.filter(
      (b) => typeof b.modelId === 'string' && b.modelId.toLowerCase().includes('flash')
    )

    const session = buildWindow(proBuckets)
    const weekly = buildWindow(flashBuckets)

    return {
      provider: 'gemini',
      session,
      weekly,
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function tryRefreshToken(creds: GeminiCredentials): Promise<string | null> {
  const geminiPath = resolveGeminiBinary()
  if (!geminiPath) {
    return null
  }

  const clientCreds = await extractOAuthClientCredentials(geminiPath)
  if (!clientCreds) {
    return null
  }

  return await refreshAccessToken(
    creds.refresh_token,
    clientCreds.clientId,
    clientCreds.clientSecret
  )
}

export async function fetchGeminiRateLimits(): Promise<ProviderRateLimits> {
  try {
    const creds = await readGeminiCredentials()
    if (!creds) {
      return {
        provider: 'gemini',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: 'Gemini CLI credentials not found',
        status: 'unavailable'
      }
    }

    let accessToken = creds.access_token

    if (creds.expiry_date < Date.now()) {
      const newToken = await tryRefreshToken(creds)
      if (!newToken) {
        return {
          provider: 'gemini',
          session: null,
          weekly: null,
          updatedAt: Date.now(),
          error: 'Token refresh failed',
          status: 'error'
        }
      }
      accessToken = newToken
    }

    let projectId = ''
    try {
      projectId = await loadProjectId(accessToken)
    } catch {
      projectId = ''
    }

    let result = await fetchQuota(accessToken, projectId)

    // Why: server may reject tokens early even when expiry_date is valid locally.
    if (result.status === 'error' && result.error?.includes('Quota fetch failed (401)')) {
      const newToken = await tryRefreshToken(creds)
      if (!newToken) {
        return {
          provider: 'gemini',
          session: null,
          weekly: null,
          updatedAt: Date.now(),
          error: 'Token refresh failed',
          status: 'error'
        }
      }
      accessToken = newToken

      try {
        projectId = await loadProjectId(accessToken)
      } catch {
        projectId = ''
      }

      result = await fetchQuota(accessToken, projectId)
    }

    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return {
      provider: 'gemini',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: message,
      status: 'error'
    }
  }
}
