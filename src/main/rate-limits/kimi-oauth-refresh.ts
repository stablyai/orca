import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync
} from 'node:fs'
import { dirname } from 'node:path'
import { net } from 'electron'
import { writeSecureJsonFile } from '../../shared/secure-file'
import type { KimiCredentialLocation } from './kimi-credential-location'

const KIMI_OAUTH_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098'
const API_TIMEOUT_MS = 10_000
const LOCK_STALE_MS = 5_000
const LOCK_RETRY_MS = 500
const LOCK_RETRIES = 120

export type KimiCredentials = {
  access_token?: string
  refresh_token?: string
  expires_at?: number
  expires_in?: number
  scope?: string
  token_type?: string
  [key: string]: unknown
}

type KimiTokenEndpointResponse = {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
  scope?: unknown
  token_type?: unknown
}

export type KimiRefreshDependencies = {
  acquireLock: <T>(target: string, action: () => Promise<T>) => Promise<T>
  readCredentials: (path: string) => KimiCredentials | null
  saveCredentials: (path: string, credentials: KimiCredentials) => void
  fetchToken: (url: string, init: RequestInit) => Promise<Response>
  nowSeconds: () => number
}

function isFresh(credentials: KimiCredentials, nowSeconds: number): boolean {
  return (
    typeof credentials.access_token === 'string' &&
    credentials.access_token.length > 0 &&
    typeof credentials.expires_at === 'number' &&
    credentials.expires_at - nowSeconds > 5
  )
}

function readCredentials(path: string): KimiCredentials | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as KimiCredentials) : null
  } catch {
    return null
  }
}

function applyRefreshedCredentials(
  credentials: KimiCredentials,
  response: KimiTokenEndpointResponse,
  nowSeconds: number
): KimiCredentials | null {
  if (typeof response.access_token !== 'string' || response.access_token.length === 0) {
    return null
  }
  if (
    typeof response.expires_in !== 'number' ||
    !Number.isFinite(response.expires_in) ||
    response.expires_in <= 5
  ) {
    return null
  }
  const refreshToken =
    typeof response.refresh_token === 'string' && response.refresh_token.length > 0
      ? response.refresh_token
      : credentials.refresh_token
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    return null
  }
  return {
    ...credentials,
    access_token: response.access_token,
    refresh_token: refreshToken,
    expires_at: nowSeconds + response.expires_in,
    expires_in: response.expires_in,
    token_type:
      typeof response.token_type === 'string' && response.token_type.length > 0
        ? response.token_type
        : credentials.token_type,
    scope:
      typeof response.scope === 'string' && response.scope.length > 0
        ? response.scope
        : credentials.scope
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function removeStaleLock(lockPath: string): void {
  try {
    if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
      rmSync(lockPath, { recursive: true, force: true })
    }
  } catch {
    // A competing process may have released or replaced the lock.
  }
}

async function acquireKimiRefreshLock<T>(target: string, action: () => Promise<T>): Promise<T> {
  if (process.platform === 'win32' || process.env.KIMI_DISABLE_OAUTH_LOCK === '1') {
    return action()
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  if (!existsSync(target)) {
    appendFileSync(target, '', { mode: 0o600 })
  }
  const lockPath = `${target}.lock`
  let acquired = false
  for (let attempt = 0; attempt <= LOCK_RETRIES; attempt += 1) {
    try {
      mkdirSync(lockPath, { mode: 0o700 })
      acquired = true
      break
    } catch (error) {
      removeStaleLock(lockPath)
      if (attempt === LOCK_RETRIES) {
        throw error
      }
      await sleep(LOCK_RETRY_MS)
    }
  }
  if (!acquired) {
    throw new Error('Unable to acquire Kimi OAuth refresh lock')
  }
  // Why: Kimi treats a 5-second-old lock as stale, so long token requests must
  // refresh the lock mtime while the rotating refresh token is in flight.
  const heartbeat = setInterval(() => {
    try {
      const now = new Date()
      utimesSync(lockPath, now, now)
    } catch {
      // Lock loss is surfaced by the protected operation or the next refresh.
    }
  }, LOCK_STALE_MS / 2)
  heartbeat.unref()
  try {
    return await action()
  } finally {
    clearInterval(heartbeat)
    try {
      rmSync(lockPath, { recursive: true, force: true })
    } catch {
      // Kimi ignores release errors as well.
    }
  }
}

const defaultDependencies: KimiRefreshDependencies = {
  acquireLock: acquireKimiRefreshLock,
  readCredentials,
  saveCredentials: writeSecureJsonFile,
  fetchToken: (url, init) => net.fetch(url, init),
  nowSeconds: () => Math.floor(Date.now() / 1000)
}

async function refreshUnderLock(
  initial: KimiCredentials,
  location: KimiCredentialLocation,
  dependencies: KimiRefreshDependencies
): Promise<KimiCredentials | null> {
  const latest = dependencies.readCredentials(location.credentialsPath) ?? initial
  if (isFresh(latest, dependencies.nowSeconds())) {
    return latest
  }
  if (typeof latest.refresh_token !== 'string' || latest.refresh_token.length === 0) {
    return null
  }
  const response = await dependencies.fetchToken(location.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: KIMI_OAUTH_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: latest.refresh_token
    }).toString(),
    signal: AbortSignal.timeout(API_TIMEOUT_MS)
  })
  if (!response.ok) {
    await sleep(100)
    const winner = dependencies.readCredentials(location.credentialsPath)
    return winner &&
      winner.refresh_token !== latest.refresh_token &&
      isFresh(winner, dependencies.nowSeconds())
      ? winner
      : null
  }
  const data = (await response.json()) as KimiTokenEndpointResponse
  const refreshed = applyRefreshedCredentials(latest, data, dependencies.nowSeconds())
  if (refreshed) {
    dependencies.saveCredentials(location.credentialsPath, refreshed)
  }
  return refreshed
}

export async function refreshKimiCredentials(
  credentials: KimiCredentials,
  location: KimiCredentialLocation,
  dependencies: KimiRefreshDependencies = defaultDependencies
): Promise<KimiCredentials | null> {
  return dependencies.acquireLock(location.lockTarget, () =>
    refreshUnderLock(credentials, location, dependencies)
  )
}
