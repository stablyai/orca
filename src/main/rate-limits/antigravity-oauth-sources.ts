import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const KEYCHAIN_SERVICE = 'gemini'
const KEYCHAIN_ACCOUNT = 'antigravity'
const GO_KEYRING_PREFIX = 'go-keyring-base64:'
const KEYCHAIN_COMMAND_TIMEOUT_MS = 3_000
const TOKEN_SKEW_MS = 5 * 60 * 1000

export type AntigravityAuthSession = {
  accessToken: string | null
  refreshToken: string | null
  expiresAtMs: number | null
  email: string | null
}

export type AntigravityAuthReadResult =
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; session: AntigravityAuthSession }

type AntigravityTokenPayload = {
  access_token?: unknown
  refresh_token?: unknown
  expiry?: unknown
}

type AntigravityOAuthFile = {
  token?: AntigravityTokenPayload
}

export function getAntigravityCliDir(home = homedir()): string {
  return path.join(home, '.gemini', 'antigravity-cli')
}

export function getAntigravityOAuthTokenPath(home = homedir()): string {
  return path.join(getAntigravityCliDir(home), 'antigravity-oauth-token')
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function parseExpiryMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000
  }
  if (typeof value !== 'string' || value.length === 0) {
    return null
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function sessionFromPayload(parsed: unknown): AntigravityAuthSession | null {
  if (typeof parsed !== 'object' || parsed === null) {
    return null
  }
  const token = (parsed as AntigravityOAuthFile).token
  if (!token || typeof token !== 'object') {
    return null
  }
  const accessToken = asNonEmptyString(token.access_token)
  const refreshToken = asNonEmptyString(token.refresh_token)
  if (!accessToken && !refreshToken) {
    return null
  }
  return {
    accessToken,
    refreshToken,
    expiresAtMs: parseExpiryMs(token.expiry),
    email: null
  }
}

export function decodeAntigravitySecret(raw: string): AntigravityAuthSession | null {
  const trimmed = raw.trim()
  if (!trimmed) {
    return null
  }
  const encoded = trimmed.startsWith(GO_KEYRING_PREFIX)
    ? trimmed.slice(GO_KEYRING_PREFIX.length)
    : trimmed
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8')
    const fromBase64 = sessionFromPayload(JSON.parse(decoded) as unknown)
    if (fromBase64) {
      return fromBase64
    }
  } catch {
    // Fall through to raw JSON, which is how the CLI writes the on-disk token file.
  }
  try {
    return sessionFromPayload(JSON.parse(trimmed) as unknown)
  } catch {
    return null
  }
}

function readSessionFromFile(tokenPath: string): AntigravityAuthReadResult {
  if (!existsSync(tokenPath)) {
    return { status: 'missing' }
  }
  try {
    const session = decodeAntigravitySecret(readFileSync(tokenPath, 'utf8'))
    if (!session) {
      return { status: 'error', error: 'Antigravity auth file is invalid' }
    }
    return { status: 'ok', session }
  } catch (error) {
    return {
      status: 'error',
      error:
        error instanceof SyntaxError
          ? 'Antigravity auth file is invalid'
          : 'Unable to read Antigravity auth file'
    }
  }
}

function execSecurity(args: string[]): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    execFile(
      'security',
      args,
      { timeout: KEYCHAIN_COMMAND_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        const code =
          error && typeof error === 'object' && 'code' in error
            ? Number((error as { code?: unknown }).code)
            : 0
        resolve({ stdout: String(stdout ?? ''), code: Number.isFinite(code) ? code : 1 })
      }
    )
  })
}

export async function hasAntigravityKeychainItem(): Promise<boolean> {
  if (process.platform !== 'darwin') {
    return false
  }
  const result = await execSecurity([
    'find-generic-password',
    '-s',
    KEYCHAIN_SERVICE,
    '-a',
    KEYCHAIN_ACCOUNT
  ])
  return result.code === 0
}

export function hasAntigravityAuthFile(home = homedir()): boolean {
  return existsSync(getAntigravityOAuthTokenPath(home))
}

export async function hasAntigravityAuthSession(home = homedir()): Promise<boolean> {
  return hasAntigravityAuthFile(home) || (await hasAntigravityKeychainItem())
}

async function readSessionFromKeychain(): Promise<AntigravityAuthReadResult> {
  if (process.platform !== 'darwin') {
    return { status: 'missing' }
  }
  const result = await execSecurity([
    'find-generic-password',
    '-s',
    KEYCHAIN_SERVICE,
    '-a',
    KEYCHAIN_ACCOUNT,
    '-w'
  ])
  if (result.code !== 0 || !result.stdout.trim()) {
    return { status: 'missing' }
  }
  const session = decodeAntigravitySecret(result.stdout)
  if (!session) {
    return { status: 'error', error: 'Antigravity keychain item is invalid' }
  }
  return { status: 'ok', session }
}

export async function readAntigravityAuthSession(
  home = homedir()
): Promise<AntigravityAuthReadResult> {
  const fromFile = readSessionFromFile(getAntigravityOAuthTokenPath(home))
  if (fromFile.status !== 'missing') {
    return fromFile
  }
  return readSessionFromKeychain()
}

export function isAntigravityAccessTokenFresh(session: AntigravityAuthSession): boolean {
  if (!session.accessToken) {
    return false
  }
  if (session.expiresAtMs === null) {
    return true
  }
  return session.expiresAtMs - Date.now() > TOKEN_SKEW_MS
}
