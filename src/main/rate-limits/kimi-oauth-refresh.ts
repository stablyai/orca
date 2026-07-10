import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { net } from 'electron'
import { lock } from 'proper-lockfile'
import { writeSecureJsonFile } from '../../shared/secure-file'
import type { KimiCredentialLocation } from './kimi-credential-location'

const KIMI_OAUTH_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098'
const API_TIMEOUT_MS = 10_000

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
  delay?: (milliseconds: number) => Promise<void>
}

export class KimiRefreshError extends Error {
  readonly kind: 'unauthorized' | 'request'
  readonly status: number

  constructor(kind: 'unauthorized' | 'request', status: number) {
    super(kind === 'unauthorized' ? 'Kimi refresh unauthorized' : 'Kimi refresh request failed')
    this.name = 'KimiRefreshError'
    this.kind = kind
    this.status = status
  }
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

async function isUnauthorizedRefreshResponse(response: Response): Promise<boolean> {
  if (response.status === 401 || response.status === 403) {
    return true
  }
  try {
    const body: unknown = await response.json()
    return (
      typeof body === 'object' && body !== null && 'error' in body && body.error === 'invalid_grant'
    )
  } catch {
    return false
  }
}

export async function acquireKimiRefreshLock<T>(
  target: string,
  action: () => Promise<T>
): Promise<T> {
  if (process.platform === 'win32' || process.env.KIMI_DISABLE_OAUTH_LOCK === '1') {
    return action()
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  if (!existsSync(target)) {
    appendFileSync(target, '', { mode: 0o600 })
  }
  // Why: these are Kimi 0.23.3's exact lock settings, so Orca coordinates with
  // the CLI's rotating refresh-token critical section across processes.
  const release = await lock(target, {
    retries: { retries: 120, factor: 1, minTimeout: 500, maxTimeout: 1000 },
    stale: 5000,
    realpath: false
  })
  try {
    return await action()
  } finally {
    try {
      await release()
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
    const unauthorized = await isUnauthorizedRefreshResponse(response)
    if (!unauthorized) {
      throw new KimiRefreshError('request', response.status)
    }
    await (dependencies.delay ?? sleep)(100)
    const winner = dependencies.readCredentials(location.credentialsPath)
    if (
      winner &&
      winner.refresh_token !== latest.refresh_token &&
      isFresh(winner, dependencies.nowSeconds())
    ) {
      return winner
    }
    // Why: Kimi revokes the stored token after a rejected refresh unless a
    // concurrently rotated fresh winner proves another process succeeded.
    dependencies.saveCredentials(location.credentialsPath, {
      ...latest,
      access_token: '',
      refresh_token: ''
    })
    throw new KimiRefreshError('unauthorized', response.status)
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
