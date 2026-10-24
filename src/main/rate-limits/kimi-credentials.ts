import { readFile } from 'node:fs/promises'
import { DEFAULT_KIMI_OAUTH_SLOT, getKimiCredentialsPath } from '../kimi/kimi-oauth-slot'
import {
  clearCachedKimiSlot,
  getCachedKimiSlot,
  readKimiActiveOAuthSlot,
  setCachedKimiSlot
} from './kimi-config-slot'
import {
  createAuthFilesystemOperation,
  type SharedAuthFilesystemOperation
} from './auth-filesystem-operation'

const CREDENTIALS_READ_TIMEOUT_MS = 5_000

export type KimiCredentials = {
  access_token?: string
  expires_at?: number
}

export type CredentialsReadResult =
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
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}

function readErrorMessage(err: unknown): string {
  // Why: AbortSignal timeouts reject with a DOMException, not an Error.
  if (
    typeof err === 'object' &&
    err !== null &&
    'message' in err &&
    typeof err.message === 'string'
  ) {
    return err.message
  }
  return 'Unable to read Kimi credentials'
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

async function readCredentialsAt(path: string): Promise<CredentialsReadResult> {
  try {
    // Why: a stopped distro parks a UNC read for minutes; bound it so a WSL home
    // degrades to an error instead of stalling the poll cycle.
    return await getCredentialsRead(path).wait(AbortSignal.timeout(CREDENTIALS_READ_TIMEOUT_MS))
  } catch (err) {
    return { status: 'error', error: readErrorMessage(err) }
  }
}

export function isAccessTokenFresh(creds: KimiCredentials): boolean {
  return (
    typeof creds.access_token === 'string' &&
    creds.access_token.length > 0 &&
    typeof creds.expires_at === 'number' &&
    // Why: small skew margin so we don't fire a request against a token that
    // expires mid-flight. The CLI refreshes the file on its next run.
    creds.expires_at - Math.floor(Date.now() / 1000) > 5
  )
}

/**
 * Reads the Kimi credentials for a home, resolving the active OAuth slot
 * lazily: default-slot users never pay for a config.toml probe, and scoped
 * users are discovered once and then served straight from their slot file
 * (#24176). Reads serialize on the shared auth-filesystem lane either way, so
 * a stopped WSL distro parks at most one read per poll — the same footprint
 * as before the scoped-slot support existed.
 */
export async function readCredentials(kimiHome: string): Promise<CredentialsReadResult> {
  const cached = getCachedKimiSlot(kimiHome)
  if (cached) {
    const scoped = await readCredentialsAt(getKimiCredentialsPath(kimiHome, cached))
    // Why: same precedence as discovery below — a scoped file that exists wins
    // even with an expired token; its delegated-refresh error beats a fresh
    // default token that may belong to a different account (#24176).
    if (scoped.status === 'ok') {
      return scoped
    }
    // Missing or unreadable cached slot: drop it and rediscover below.
    clearCachedKimiSlot(kimiHome)
  }
  const fallback = await readCredentialsAt(
    getKimiCredentialsPath(kimiHome, DEFAULT_KIMI_OAUTH_SLOT)
  )
  // Why: default-slot users — including everyone on the shared default
  // environment — never pay for the config probe. It only runs when the
  // default slot is missing or stale, which is exactly the scoped-slot
  // signature (#24176). Read errors (e.g. a stalled WSL UNC read already
  // bounded above) return as-is without probing further.
  if (
    fallback.status === 'error' ||
    (fallback.status === 'ok' && isAccessTokenFresh(fallback.credentials))
  ) {
    return fallback
  }
  const slot = await readKimiActiveOAuthSlot(kimiHome)
  if (!slot || slot === DEFAULT_KIMI_OAUTH_SLOT) {
    return fallback
  }
  const scoped = await readCredentialsAt(getKimiCredentialsPath(kimiHome, slot))
  // Why: a scoped file that exists always wins, even with an expired token —
  // surfacing the delegated-refresh error beats silently reading a stale
  // default token that may belong to a different account. A scoped file that
  // was never written falls back to the default result.
  if (scoped.status === 'ok') {
    setCachedKimiSlot(kimiHome, slot)
    return scoped
  }
  return fallback
}
