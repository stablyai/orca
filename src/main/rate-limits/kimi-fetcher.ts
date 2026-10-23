import { abortSignalWithTimeout } from '../lib/abort-signal-with-timeout'
import { readFile } from 'node:fs/promises'
import { join, win32 as pathWin32 } from 'node:path'
import { getMainHttpClient } from '../network/http-client'
import type { ProviderRateLimits, UsageRateLimitMetadata } from '../../shared/rate-limit-types'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { getHostKimiHome, type KimiHomeResolution } from '../kimi/kimi-runtime-home'
import {
  createAuthFilesystemOperation,
  type SharedAuthFilesystemOperation
} from './auth-filesystem-operation'
import { mapKimiUsageResponse } from './kimi-usage-response'
import { classifyThrownUsageRequestError } from './usage-request-failure-kind'

// Why: Kimi Code's managed coding plan exposes subscription usage at
// `${base}/usages` (see packages/oauth/src/managed-usage.ts in the CLI bundle).
// The base URL is overridable via the same env var the CLI honours so Orca
// stays aligned with a user's self-hosted/staging config.
const KIMI_BASE_URL = process.env.KIMI_CODE_BASE_URL ?? 'https://api.kimi.com/coding/v1'
const API_TIMEOUT_MS = 10_000
const CREDENTIALS_READ_TIMEOUT_MS = 5_000

function getCredentialsPath(kimiHome: string): string {
  // WSL homes arrive as `\\wsl.localhost\<distro>\...`, which only win32 join keeps intact.
  return parseWslUncPath(kimiHome)
    ? pathWin32.join(kimiHome, 'credentials', 'kimi-code.json')
    : join(kimiHome, 'credentials', 'kimi-code.json')
}

type KimiCredentials = {
  access_token?: string
  expires_at?: number
}

type CredentialsReadResult =
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; credentials: KimiCredentials }

function parseCredentials(value: unknown): KimiCredentials | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const credentials: KimiCredentials = {}
  if ('access_token' in value && typeof value.access_token === 'string') {
    credentials.access_token = value.access_token
  }
  if ('expires_at' in value && typeof value.expires_at === 'number') {
    credentials.expires_at = value.expires_at
  }
  return credentials
}

const credentialsReadByPath = new Map<
  string,
  SharedAuthFilesystemOperation<CredentialsReadResult>
>()

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function readErrorMessage(err: unknown): string {
  // Why: AbortSignal timeouts reject with a DOMException, not an Error.
  const message = (err as { message?: unknown } | null)?.message
  return typeof message === 'string' ? message : 'Unable to read Kimi credentials'
}

function getCredentialsRead(path: string): SharedAuthFilesystemOperation<CredentialsReadResult> {
  const existing = credentialsReadByPath.get(path)
  if (existing) {
    return existing
  }
  // Why: aborting an fs promise does not cancel an already issued UNC request, so
  // share one raw read per path until it settles (mirrors codex-fetcher's auth read).
  const read = createAuthFilesystemOperation(path, async (): Promise<CredentialsReadResult> => {
    let raw: string
    try {
      raw = await readFile(path, 'utf-8')
    } catch (err) {
      return isMissingPathError(err)
        ? { status: 'missing' }
        : { status: 'error', error: readErrorMessage(err) }
    }
    try {
      const credentials = parseCredentials(JSON.parse(raw))
      return credentials
        ? { status: 'ok', credentials }
        : { status: 'error', error: 'Kimi credentials file is invalid' }
    } catch (err) {
      return { status: 'error', error: readErrorMessage(err) }
    }
  })
  credentialsReadByPath.set(path, read)
  const clearRead = (): void => {
    if (credentialsReadByPath.get(path) === read) {
      credentialsReadByPath.delete(path)
    }
  }
  void read.result.then(clearRead, clearRead)
  return read
}

async function readCredentials(
  kimiHome: string,
  signal?: AbortSignal
): Promise<CredentialsReadResult> {
  signal?.throwIfAborted()
  const path = getCredentialsPath(kimiHome)
  try {
    // Why: a stopped distro parks a UNC read for minutes; bound it so a WSL home
    // degrades to an error instead of stalling the poll cycle.
    return await getCredentialsRead(path).wait(
      abortSignalWithTimeout(signal, CREDENTIALS_READ_TIMEOUT_MS)
    )
  } catch (err) {
    signal?.throwIfAborted()
    return { status: 'error', error: readErrorMessage(err) }
  }
}

function isAccessTokenFresh(creds: KimiCredentials): boolean {
  return (
    typeof creds.access_token === 'string' &&
    creds.access_token.length > 0 &&
    typeof creds.expires_at === 'number' &&
    // Why: small skew margin so we don't fire a request against a token that
    // expires mid-flight. The CLI refreshes the file on its next run.
    creds.expires_at - Math.floor(Date.now() / 1000) > 5
  )
}

// A bare "operation was aborted due to timeout" hides which machine stalled.
function readErrorContext(home: KimiHomeResolution, error: string): string {
  return home.runtime === 'wsl' ? `${error} (WSL ${home.wslDistro ?? 'default distro'})` : error
}

function expiredSessionMessage(home: KimiHomeResolution): string {
  const where =
    home.runtime === 'wsl'
      ? `inside WSL (${home.wslDistro ?? 'default distro'})`
      : 'on the computer running Orca'
  return `Kimi session expired — run kimi ${where}, then retry usage.`
}

function result(
  status: ProviderRateLimits['status'],
  error: string | null,
  usageMetadata?: UsageRateLimitMetadata
): ProviderRateLimits {
  return {
    provider: 'kimi',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status,
    ...(usageMetadata ? { usageMetadata } : {})
  }
}

/**
 * Read-only subscription usage for Kimi Code.
 *
 * `home` selects which machine's credentials to read: on Windows the Kimi CLI
 * often runs inside WSL, and only that copy is refreshed (#12370). Defaults to
 * the host home.
 *
 * Why read-only: the access token lives in `<kimi home>/credentials/kimi-code.json`
 * and is refreshed by the Kimi CLI itself (15-min TTL, refresh-token rotation).
 * Orca must NEVER refresh or rewrite that file — a rotated refresh token would
 * log out a live `kimi` session. We only read the current token and call the
 * same `GET /usages` endpoint, with the same headers, that the CLI's own
 * `/usage` command uses. The completion endpoint (the one Moonshot gates to
 * approved coding agents) is never touched here.
 */
export async function fetchKimiRateLimits(options?: {
  home?: KimiHomeResolution
  signal?: AbortSignal
}): Promise<ProviderRateLimits> {
  const signal = options?.signal
  signal?.throwIfAborted()
  const home: KimiHomeResolution = options?.home ?? {
    runtime: 'host',
    wslDistro: null,
    path: getHostKimiHome()
  }
  if (home.path === null) {
    return result('error', `WSL Kimi home unavailable for ${home.wslDistro ?? 'default distro'}`)
  }
  const readResult = await readCredentials(home.path, signal)
  signal?.throwIfAborted()
  if (readResult.status === 'missing') {
    return result('unavailable', 'Not signed in to Kimi Code')
  }
  if (readResult.status === 'error') {
    return result('error', readErrorContext(home, readResult.error))
  }
  const creds = readResult.credentials
  if (typeof creds.access_token !== 'string' || creds.access_token.length === 0) {
    return result('error', 'Kimi credentials file is missing an access token')
  }
  if (!isAccessTokenFresh(creds)) {
    // Why: don't refresh — the CLI owns the token lifecycle. Report a transient
    // error so the rate-limit service keeps the last good snapshot (stale
    // policy) until the user next runs Kimi and the CLI refreshes the file.
    return result('error', expiredSessionMessage(home), {
      failureKind: 'delegated-refresh-required',
      source: 'oauth'
    })
  }

  try {
    const res = await getMainHttpClient().fetch(`${KIMI_BASE_URL.replace(/\/$/, '')}/usages`, {
      // Why: identical to the CLI's fetchManagedUsage — bearer token + Accept.
      // No extra User-Agent: the usages endpoint authenticates by token only.
      headers: { Authorization: `Bearer ${creds.access_token}`, Accept: 'application/json' },
      signal: abortSignalWithTimeout(signal, API_TIMEOUT_MS)
    })
    signal?.throwIfAborted()
    if (res.status === 401 || res.status === 403) {
      return result('error', `Kimi usage request unauthorized (HTTP ${res.status})`)
    }
    if (!res.ok) {
      return result('error', `Kimi usage request failed (HTTP ${res.status})`)
    }
    const data: unknown = await res.json()
    signal?.throwIfAborted()
    return mapKimiUsageResponse(typeof data === 'object' && data !== null ? data : {})
  } catch (err) {
    signal?.throwIfAborted()
    return result('error', err instanceof Error ? err.message : 'Kimi usage request failed', {
      failureKind: classifyThrownUsageRequestError(err)
    })
  }
}
