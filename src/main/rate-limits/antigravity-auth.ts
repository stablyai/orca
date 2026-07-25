import { net } from 'electron'
import { homedir } from 'node:os'
import path from 'node:path'
import { readFile } from 'node:fs/promises'

const API_TIMEOUT = 10_000
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

// Why: OpenUsage Antigravity shipped client pair used by AGY binary
export const ANTIGRAVITY_CLIENT_ID =
  '1071006060591-2n2a9v6u8l1d2m5d6v3v93n9n0c74a00.apps.googleusercontent.com'
export const ANTIGRAVITY_CLIENT_SECRET = 'GOCSPX-K58h_8z180j_n28h67209n1h670'

export type AntigravityToken = {
  access_token: string
  refresh_token?: string
  expiry_date?: number
}

type RawTokenData = {
  token?: {
    access_token?: string
    refresh_token?: string
    expiry_date?: number | string
    expiry?: number | string
    expires_in?: number
  }
  access_token?: string
  refresh_token?: string
  expiry_date?: number | string
  expiry?: number | string
  expires_in?: number
}

// Why: Minimal source-bound cache prevents 15s poll refresh loops & invalidates naturally when refresh token changes
let cachedRefreshedToken: {
  sourceRefreshToken: string
  accessToken: string
  expiresAt: number
} | null = null

/**
 * Clears source-bound auth state so later reads cannot reuse a stale account token.
 */
export function clearAntigravityAuthCache(): void {
  cachedRefreshedToken = null
}

/**
 * Normalizes numeric and ISO expiry values used by Antigravity credential stores.
 *
 * @param val Candidate expiry value.
 * @returns Epoch milliseconds when valid; otherwise `undefined`.
 */
export function parseExpiryTimestamp(val: unknown): number | undefined {
  if (typeof val === 'number') {
    return val
  }
  if (typeof val === 'string') {
    const parsed = Date.parse(val)
    if (!Number.isNaN(parsed)) {
      return parsed
    }
  }
  return undefined
}

/**
 * Parses both flat and nested Antigravity token payloads into one credential shape.
 *
 * @param data Untrusted credential payload.
 * @returns A normalized token when the payload contains an access token; otherwise `null`.
 */
export function parseAntigravityToken(data: unknown): AntigravityToken | null {
  if (!data || typeof data !== 'object') {
    return null
  }
  const obj = data as RawTokenData
  const target =
    obj.token && typeof obj.token === 'object' && typeof obj.token.access_token === 'string'
      ? obj.token
      : obj
  if (typeof target.access_token !== 'string') {
    return null
  }

  const expiry =
    parseExpiryTimestamp(target.expiry) ??
    parseExpiryTimestamp(target.expiry_date) ??
    (typeof target.expires_in === 'number' ? Date.now() + target.expires_in * 1000 : undefined)

  return {
    access_token: target.access_token,
    refresh_token: typeof target.refresh_token === 'string' ? target.refresh_token : undefined,
    expiry_date: expiry
  }
}

/**
 * Searches supported native and compatibility paths for the first valid token payload.
 *
 * @param baseHomedir Home directory used to resolve credential candidates.
 * @returns The first valid token found, or `null` when no candidate is usable.
 */
export async function readAntigravityCredentialsFromDisk(
  baseHomedir = homedir()
): Promise<AntigravityToken | null> {
  const candidatePaths = [
    path.join(baseHomedir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
    path.join(baseHomedir, '.config', 'antigravity', 'antigravity-oauth-token.json'),
    path.join(baseHomedir, '.gemini', 'antigravity-cli', 'auth.json'),
    path.join(baseHomedir, '.gemini', 'antigravity-cli', 'settings.json')
  ]

  for (const candidatePath of candidatePaths) {
    try {
      const raw = await readFile(candidatePath, 'utf-8')
      const token = parseAntigravityToken(JSON.parse(raw))
      if (token) {
        return token
      }
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        continue
      }
    }
  }

  return null
}

/**
 * Refreshes an Antigravity access token and caches it against its source refresh token.
 *
 * @param refreshToken OAuth refresh token from the native credential store.
 * @returns The refreshed token, or `null` when the refresh request fails.
 */
export async function refreshAntigravityToken(
  refreshToken: string
): Promise<AntigravityToken | null> {
  try {
    const params = new URLSearchParams({
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET
    })
    const res = await net.fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(API_TIMEOUT)
    })
    if (!res.ok) {
      return null
    }
    const data = (await res.json()) as { access_token?: string; expires_in?: number }
    if (typeof data.access_token === 'string') {
      const expiresAt = data.expires_in
        ? Date.now() + data.expires_in * 1000
        : Date.now() + 3600 * 1000
      cachedRefreshedToken = {
        sourceRefreshToken: refreshToken,
        accessToken: data.access_token,
        expiresAt
      }
      return {
        access_token: data.access_token,
        refresh_token: refreshToken,
        expiry_date: expiresAt
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Returns a fresh disk or cached token, refreshing only when the current source requires it.
 *
 * @param baseHomedir Home directory used to resolve credential candidates.
 * @returns The best available token, or `null` when no credentials exist.
 */
export async function getValidAntigravityToken(
  baseHomedir = homedir()
): Promise<AntigravityToken | null> {
  const diskToken = await readAntigravityCredentialsFromDisk(baseHomedir)
  if (!diskToken) {
    return null
  }

  // 1. If disk access_token is still fresh, use it directly
  if (diskToken.expiry_date && diskToken.expiry_date > Date.now() + 60_000) {
    return diskToken
  }

  // 2. If disk access_token is expired, check if memory cache has valid refreshed token for exact same refresh_token
  if (
    diskToken.refresh_token &&
    cachedRefreshedToken &&
    cachedRefreshedToken.sourceRefreshToken === diskToken.refresh_token &&
    cachedRefreshedToken.expiresAt > Date.now() + 60_000
  ) {
    return {
      access_token: cachedRefreshedToken.accessToken,
      refresh_token: diskToken.refresh_token,
      expiry_date: cachedRefreshedToken.expiresAt
    }
  }

  // 3. Otherwise refresh via OAuth
  if (diskToken.refresh_token) {
    const refreshed = await refreshAntigravityToken(diskToken.refresh_token)
    if (refreshed) {
      return refreshed
    }
  }

  return diskToken
}
