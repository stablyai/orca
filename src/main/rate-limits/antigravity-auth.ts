import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readAntigravityKeyring } from './antigravity-keychain'
import {
  AntigravityAuthError,
  type AntigravityAccessToken,
  type AntigravityCredentialSource,
  type ParsedCredentials,
  type TokenEnvelope
} from './antigravity-auth-types'
import { refreshAntigravitySingleFlight } from './antigravity-token-refresh'

export { ANTIGRAVITY_CLIENT_ID, ANTIGRAVITY_CLIENT_SECRET } from './antigravity-token-refresh'
export { AntigravityAuthError } from './antigravity-auth-types'
export type {
  AntigravityAccessToken,
  AntigravityCredentialSource,
  ParsedCredentials
} from './antigravity-auth-types'

const ANTIGRAVITY_TOKEN_PATH_PARTS = [
  '.gemini',
  'antigravity-cli',
  'antigravity-oauth-token'
] as const
const TOKEN_SKEW_MS = 60_000
const KEYRING_VALUE_PREFIX = 'go-keyring-base64:'

let cachedCredentials: ParsedCredentials | null = null

export async function getAntigravityAccessToken(
  options: {
    baseHomeDir?: string
    forceRefresh?: boolean
    signal?: AbortSignal
  } = {}
): Promise<AntigravityAccessToken> {
  const baseHomeDir = options.baseHomeDir ?? homedir()
  throwIfAborted(options.signal)
  let credentials =
    cachedCredentials?.baseHomeDir === baseHomeDir
      ? cachedCredentials
      : await readAntigravityCredentials(baseHomeDir, options.signal)

  if (!options.forceRefresh && isAccessTokenFresh(credentials)) {
    return toAccessToken(credentials)
  }
  if (!credentials.refreshToken) {
    throw new AntigravityAuthError('Antigravity sign-in expired', 'stale-token')
  }

  const refreshed = await refreshAntigravitySingleFlight(credentials, options.signal)
  credentials = {
    ...credentials,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresAtMs: refreshed.expiresAtMs
  }
  cachedCredentials = credentials
  return toAccessToken(credentials)
}

export function invalidateAntigravityAccessToken(sourceKey: string): void {
  if (cachedCredentials?.sourceKey === sourceKey) {
    // Why: a 401 can mean the CLI was re-authenticated elsewhere; force the
    // next request to re-read the official keyring/token file authority.
    cachedCredentials = null
  }
}

export async function readAntigravityCredentials(
  baseHomeDir = homedir(),
  signal?: AbortSignal
): Promise<ParsedCredentials> {
  throwIfAborted(signal)
  const keyring = await readAntigravityKeyring(signal)
  if (keyring.status === 'found') {
    const parsed = parseCredentialValue(keyring.value, 'official-keychain', baseHomeDir)
    cachedCredentials = parsed
    return parsed
  }

  const tokenPath = join(baseHomeDir, ...ANTIGRAVITY_TOKEN_PATH_PARTS)
  try {
    const raw = await readFile(tokenPath, 'utf8')
    const parsed = parseCredentialValue(raw, 'official-token-file', baseHomeDir)
    cachedCredentials = parsed
    return parsed
  } catch (error) {
    if (error instanceof AntigravityAuthError) {
      throw error
    }
    if (!isFileNotFoundError(error)) {
      throw new AntigravityAuthError('Unable to read Antigravity credentials', 'parse')
    }
    if (keyring.status === 'unavailable') {
      throw new AntigravityAuthError(
        'Antigravity system keyring is unavailable',
        'keychain-unavailable'
      )
    }
    throw new AntigravityAuthError('Antigravity credentials not found', 'missing-credentials')
  }
}

function toAccessToken(credentials: ParsedCredentials): AntigravityAccessToken {
  if (!credentials.accessToken) {
    throw new AntigravityAuthError('Antigravity access token is missing', 'stale-token')
  }
  return {
    accessToken: credentials.accessToken,
    credentialSource: credentials.source,
    sourceKey: credentials.sourceKey
  }
}

function parseCredentialValue(
  raw: string,
  source: AntigravityCredentialSource,
  baseHomeDir: string
): ParsedCredentials {
  let decoded = raw.trim()
  if (decoded.startsWith(KEYRING_VALUE_PREFIX)) {
    decoded = Buffer.from(decoded.slice(KEYRING_VALUE_PREFIX.length), 'base64').toString('utf8')
  }

  let envelope: unknown
  try {
    envelope = JSON.parse(decoded)
  } catch {
    throw new AntigravityAuthError('Antigravity credential record is invalid', 'parse')
  }
  if (!isTokenEnvelope(envelope)) {
    throw new AntigravityAuthError('Antigravity credential record is invalid', 'parse')
  }
  return {
    source,
    sourceKey: `${source}:${baseHomeDir}`,
    tokenPath:
      source === 'official-token-file' ? join(baseHomeDir, ...ANTIGRAVITY_TOKEN_PATH_PARTS) : null,
    envelope,
    accessToken: envelope.token.access_token,
    refreshToken:
      typeof envelope.token.refresh_token === 'string' ? envelope.token.refresh_token : '',
    expiresAtMs: parseExpiry(envelope.token.expiry),
    baseHomeDir
  }
}

function isTokenEnvelope(value: unknown): value is TokenEnvelope {
  if (typeof value !== 'object' || value === null || !('token' in value)) {
    return false
  }
  const token = (value as { token?: unknown }).token
  return (
    typeof token === 'object' &&
    token !== null &&
    'access_token' in token &&
    typeof (token as { access_token?: unknown }).access_token === 'string' &&
    (token as { access_token: string }).access_token.length > 0
  )
}

function parseExpiry(value: string | number | undefined): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function isAccessTokenFresh(credentials: ParsedCredentials): boolean {
  return credentials.expiresAtMs === null || credentials.expiresAtMs - Date.now() > TOKEN_SKEW_MS
}

function isFileNotFoundError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError()
  }
}

function createAbortError(): Error {
  return Object.assign(new Error('Antigravity request aborted'), { name: 'AbortError' })
}
