import { existsSync, readFileSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

const TOKEN_SKEW_MS = 5 * 60 * 1000

export function getAntigravityCliDir(home = homedir()): string {
  return path.join(home, '.gemini', 'antigravity-cli')
}

export function getAntigravityOAuthTokenPath(home = homedir()): string {
  return path.join(getAntigravityCliDir(home), 'antigravity-oauth-token')
}

export type AntigravityAuthSession = {
  accessToken: string | null
  refreshToken: string | null
  expiresAtMs: number | null
  authMethod: string | null
  email: string | null
}

export type AntigravityAuthReadResult =
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; session: AntigravityAuthSession }

type AntigravityTokenPayload = {
  access_token?: unknown
  refresh_token?: unknown
  token_type?: unknown
  expiry?: unknown
}

type AntigravityOAuthFile = {
  auth_method?: unknown
  token?: AntigravityTokenPayload
}

function getAuthReadError(err: unknown): string {
  if (err instanceof SyntaxError) {
    return 'Antigravity auth file is invalid'
  }
  // Why: filesystem errors often include the home path; account status must not.
  return 'Unable to read Antigravity auth file'
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

function readActiveGoogleAccountEmail(home: string): string | null {
  try {
    const raw = readFileSync(path.join(home, '.gemini', 'google_accounts.json'), 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || !('active' in parsed)) {
      return null
    }
    const active = (parsed as { active?: unknown }).active
    return typeof active === 'string' && active.includes('@') ? active : null
  } catch {
    return null
  }
}

function sessionFromFile(
  parsed: AntigravityOAuthFile,
  home: string
): AntigravityAuthSession | null {
  const token = parsed.token
  if (!token) {
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
    authMethod: asNonEmptyString(parsed.auth_method),
    email: readActiveGoogleAccountEmail(home)
  }
}

export function readAntigravityAuthSession(home = homedir()): AntigravityAuthReadResult {
  const tokenPath = getAntigravityOAuthTokenPath(home)
  if (!existsSync(tokenPath)) {
    return { status: 'missing' }
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(tokenPath, 'utf-8'))
    if (typeof parsed !== 'object' || parsed === null) {
      return { status: 'error', error: 'Antigravity auth file is invalid' }
    }
    const session = sessionFromFile(parsed as AntigravityOAuthFile, home)
    if (!session) {
      return { status: 'missing' }
    }
    return { status: 'ok', session }
  } catch (err) {
    return { status: 'error', error: getAuthReadError(err) }
  }
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

export function isAntigravitySessionUsable(session: AntigravityAuthSession): boolean {
  return Boolean(session.refreshToken) || isAntigravityAccessTokenFresh(session)
}

export async function saveAntigravityCredentials(
  session: AntigravityAuthSession,
  home = homedir()
): Promise<void> {
  const tokenPath = getAntigravityOAuthTokenPath(home)
  const payload: AntigravityOAuthFile = {
    ...(session.authMethod ? { auth_method: session.authMethod } : {}),
    token: {
      ...(session.accessToken ? { access_token: session.accessToken } : {}),
      ...(session.refreshToken ? { refresh_token: session.refreshToken } : {}),
      token_type: 'Bearer',
      ...(session.expiresAtMs !== null
        ? { expiry: new Date(session.expiresAtMs).toISOString() }
        : {})
    }
  }
  const tmpPath = `${tokenPath}.${process.pid}.tmp`
  await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
  await rename(tmpPath, tokenPath)
}

export async function readAntigravityDefaultProjectId(home = homedir()): Promise<string | null> {
  try {
    const raw = await readFile(
      path.join(getAntigravityCliDir(home), 'cache', 'default_project_id.txt'),
      'utf-8'
    )
    const projectId = raw.trim()
    return projectId.length > 0 ? projectId : null
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return null
    }
    throw err
  }
}
