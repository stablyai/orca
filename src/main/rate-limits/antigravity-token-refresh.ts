import { rename, writeFile } from 'node:fs/promises'
import { net } from 'electron'
import { writeAntigravityKeyring } from './antigravity-keychain'
import {
  AntigravityAuthError,
  type ParsedCredentials,
  type RefreshedCredentials,
  type TokenEnvelope
} from './antigravity-auth-types'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const API_TIMEOUT_MS = 10_000
const KEYRING_VALUE_PREFIX = 'go-keyring-base64:'

// Why: these public native-app credentials are embedded in the official agy binary.
export const ANTIGRAVITY_CLIENT_ID =
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'
export const ANTIGRAVITY_CLIENT_SECRET = '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'

type RefreshFlight = {
  sourceKey: string
  controller: AbortController
  promise: Promise<RefreshedCredentials>
  consumers: number
}

const refreshFlights = new Map<string, RefreshFlight>()

export function refreshAntigravitySingleFlight(
  credentials: ParsedCredentials,
  signal?: AbortSignal
): Promise<RefreshedCredentials> {
  const existing = refreshFlights.get(credentials.sourceKey)
  if (existing) {
    return waitForRefresh(existing, signal)
  }

  const controller = new AbortController()
  let flight!: RefreshFlight
  const promise = refreshCredential(credentials, controller.signal)
    .then(async (refreshed) => {
      if (refreshed.refreshToken !== credentials.refreshToken) {
        await persistRotatedCredentials(credentials, refreshed, controller.signal)
      }
      return refreshed
    })
    .finally(() => {
      if (refreshFlights.get(credentials.sourceKey) === flight) {
        refreshFlights.delete(credentials.sourceKey)
      }
    })
  flight = { sourceKey: credentials.sourceKey, controller, promise, consumers: 0 }
  refreshFlights.set(credentials.sourceKey, flight)
  return waitForRefresh(flight, signal)
}

function waitForRefresh(
  flight: RefreshFlight,
  signal?: AbortSignal
): Promise<RefreshedCredentials> {
  flight.consumers += 1
  return new Promise((resolve, reject) => {
    let settled = false
    const release = (): void => {
      flight.consumers = Math.max(0, flight.consumers - 1)
      if (flight.consumers === 0) {
        if (refreshFlights.get(flight.sourceKey) === flight) {
          refreshFlights.delete(flight.sourceKey)
        }
        flight.controller.abort()
      }
    }
    const finish = (callback: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      signal?.removeEventListener('abort', onAbort)
      release()
      callback()
    }
    const onAbort = (): void => {
      finish(() => reject(createAbortError()))
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    flight.promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error))
    )
    if (signal?.aborted) {
      onAbort()
    }
  })
}

async function refreshCredential(
  credentials: ParsedCredentials,
  signal: AbortSignal
): Promise<RefreshedCredentials> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(API_TIMEOUT_MS)])
  let response: Response
  try {
    response = await net.fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: ANTIGRAVITY_CLIENT_ID,
        client_secret: ANTIGRAVITY_CLIENT_SECRET,
        refresh_token: credentials.refreshToken,
        grant_type: 'refresh_token'
      }).toString(),
      signal: requestSignal
    })
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    throw new AntigravityAuthError('Antigravity token refresh failed', 'network')
  }

  const body = (await response.json().catch(() => ({}))) as {
    access_token?: unknown
    refresh_token?: unknown
    expires_in?: unknown
    id_token?: unknown
  }
  if (!response.ok) {
    const failureKind =
      response.status === 400 || response.status === 401 ? 'stale-token' : 'server'
    throw new AntigravityAuthError('Antigravity token refresh failed', failureKind, response.status)
  }
  if (
    typeof body.access_token !== 'string' ||
    typeof body.expires_in !== 'number' ||
    !Number.isFinite(body.expires_in) ||
    body.expires_in <= 0
  ) {
    throw new AntigravityAuthError('Antigravity token refresh response is invalid', 'parse')
  }
  return {
    accessToken: body.access_token,
    refreshToken:
      typeof body.refresh_token === 'string' && body.refresh_token.length > 0
        ? body.refresh_token
        : credentials.refreshToken,
    expiresAtMs: Date.now() + body.expires_in * 1000,
    ...(typeof body.id_token === 'string' ? { idToken: body.id_token } : {})
  }
}

async function persistRotatedCredentials(
  credentials: ParsedCredentials,
  refreshed: RefreshedCredentials,
  signal?: AbortSignal
): Promise<void> {
  const envelope = buildUpdatedEnvelope(credentials.envelope, refreshed)
  try {
    if (credentials.source === 'official-keychain') {
      await writeAntigravityKeyring(
        `${KEYRING_VALUE_PREFIX}${Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64')}`,
        signal
      )
      return
    }
    if (!credentials.tokenPath) {
      throw new Error('Antigravity token file path is missing')
    }
    const temporaryPath = `${credentials.tokenPath}.${process.pid}.tmp`
    await writeFile(temporaryPath, JSON.stringify(envelope, null, 2), {
      encoding: 'utf8',
      mode: 0o600
    })
    await rename(temporaryPath, credentials.tokenPath)
  } catch {
    throw new AntigravityAuthError(
      'Antigravity rotated credentials could not be saved',
      'keychain-unavailable'
    )
  }
}

function buildUpdatedEnvelope(
  envelope: TokenEnvelope,
  refreshed: RefreshedCredentials
): TokenEnvelope {
  return {
    ...envelope,
    ...(refreshed.idToken ? { id_token: refreshed.idToken } : {}),
    token: {
      ...envelope.token,
      access_token: refreshed.accessToken,
      refresh_token: refreshed.refreshToken,
      expiry: new Date(refreshed.expiresAtMs).toISOString()
    }
  }
}

function createAbortError(): Error {
  return Object.assign(new Error('Antigravity request aborted'), { name: 'AbortError' })
}

function isAbortError(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && 'name' in error && error.name === 'AbortError'
  )
}
