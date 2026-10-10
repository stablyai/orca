import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readCursorAuthSession, type CursorAuthReadResult } from '../rate-limits/cursor-auth'
import { cursorSdkHomePath } from './cursor-structured-location-support'

const LOGIN_TTL_MS = 7_776_000_000
const KEY_NAME = 'Orca'
const MINT_TIMEOUT_MS = 15_000

type SessionLoginDeps = {
  readSession?: () => Promise<CursorAuthReadResult>
  fetchImpl?: typeof fetch
  authPath?: string
  now?: () => number
  backendUrl?: string
}

function sdkBackendUrl(explicit?: string): string {
  return (explicit ?? process.env.CURSOR_BACKEND_URL ?? 'https://api2.cursor.sh').replace(
    /\/+$/,
    ''
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function storedKeyUsable(value: unknown, now: number, backendUrl: string): boolean {
  if (!isRecord(value) || value.version !== 1 || value.backendUrl !== backendUrl) {
    return false
  }
  if (typeof value.apiKey !== 'string' || value.apiKey.length === 0) {
    return false
  }
  return (
    value.apiKeyExpiresAtMs === undefined ||
    (typeof value.apiKeyExpiresAtMs === 'number' && value.apiKeyExpiresAtMs > now)
  )
}

async function hasStoredSdkLogin(
  authPath: string,
  now: number,
  backendUrl: string
): Promise<boolean> {
  try {
    return storedKeyUsable(JSON.parse(await readFile(authPath, 'utf8')), now, backendUrl)
  } catch {
    return false
  }
}

async function mintSdkKey(
  fetchImpl: typeof fetch,
  backendUrl: string,
  accessToken: string,
  expiresAtMs: number
): Promise<{ apiKey: string } | null> {
  const response = await fetchImpl(`${backendUrl}/aiserver.v1.DashboardService/CreateUserApiKey`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1'
    },
    body: JSON.stringify({ name: KEY_NAME, expiresAt: String(expiresAtMs) }),
    signal: AbortSignal.timeout(MINT_TIMEOUT_MS)
  })
  if (!response.ok) {
    return null
  }
  const body: unknown = await response.json()
  if (!isRecord(body) || typeof body.apiKey !== 'string' || body.apiKey.length === 0) {
    return null
  }
  return { apiKey: body.apiKey }
}

async function writeSdkLogin(
  authPath: string,
  credentials: {
    backendUrl: string
    apiKey: string
    apiKeyExpiresAtMs: number
    email?: string
    createdAtMs: number
  }
): Promise<void> {
  await mkdir(dirname(authPath), { recursive: true, mode: 0o700 })
  await writeFile(authPath, JSON.stringify({ version: 1, ...credentials }), {
    encoding: 'utf8',
    mode: 0o600
  })
  if (process.platform === 'win32') {
    return
  }
  await chmod(dirname(authPath), 0o700)
  await chmod(authPath, 0o600)
}

/** Mint the SDK's user API key from the Cursor login already on this machine. */
export async function ensureCursorSdkLoginFromSession(
  deps: SessionLoginDeps = {}
): Promise<boolean> {
  const now = deps.now ?? Date.now
  const backendUrl = sdkBackendUrl(deps.backendUrl)
  const authPath = deps.authPath ?? join(cursorSdkHomePath(), 'auth.json')
  const nowMs = now()
  if (await hasStoredSdkLogin(authPath, nowMs, backendUrl)) {
    return true
  }
  // Any failure here leaves the SDK's own browser login to run.
  return mintAndStoreSdkLogin(deps, backendUrl, authPath, nowMs).catch(() => false)
}

async function mintAndStoreSdkLogin(
  deps: SessionLoginDeps,
  backendUrl: string,
  authPath: string,
  nowMs: number
): Promise<boolean> {
  const session = await (deps.readSession ?? readCursorAuthSession)()
  if (session.status !== 'ok') {
    return false
  }
  const expiresAtMs = nowMs + LOGIN_TTL_MS
  const minted = await mintSdkKey(
    deps.fetchImpl ?? fetch,
    backendUrl,
    session.session.token.raw,
    expiresAtMs
  )
  if (!minted) {
    return false
  }
  const email = session.session.email ?? undefined
  await writeSdkLogin(authPath, {
    backendUrl,
    apiKey: minted.apiKey,
    apiKeyExpiresAtMs: expiresAtMs,
    ...(email ? { email } : {}),
    createdAtMs: nowMs
  })
  return true
}

let inflight: Promise<boolean> | null = null

/** One mint at a time. A stored key short-circuits the next call. */
export function ensureCursorSdkLoginFromSessionOnce(): Promise<boolean> {
  inflight ??= ensureCursorSdkLoginFromSession().finally(() => {
    inflight = null
  })
  return inflight
}
