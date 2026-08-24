import { readFile } from 'node:fs/promises'
import { join, win32 as pathWin32 } from 'node:path'
import { resolveGrokHomeDir } from '../../shared/grok-session-paths'
import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  createAuthFilesystemOperation,
  type SharedAuthFilesystemOperation
} from './auth-filesystem-operation'

/** Resolve the Grok home exactly as Grok CLI does, including `GROK_HOME`. */
export function getGrokHome(): string {
  return resolveGrokHomeDir()
}

/** Locate `auth.json` under an explicit host or WSL Grok home. */
export function getGrokAuthPath(home: string = getGrokHome()): string {
  return parseWslUncPath(home) ? pathWin32.join(home, 'auth.json') : join(home, 'auth.json')
}

export type GrokAuthSession = {
  accessToken: string
  userId: string | null
  email: string | null
  teamId: string | null
  expiresAtMs: number | null
  oidcClientId: string | null
}

type GrokAuthEntry = {
  key?: string
  user_id?: string
  email?: string
  team_id?: string
  expires_at?: string
  oidc_client_id?: string
}

type TokenizedGrokAuthEntry = GrokAuthEntry & { key: string }

export type GrokAuthReadResult =
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; session: GrokAuthSession }

const AUTH_READ_TIMEOUT_MS = 5_000
const authReadByPath = new Map<string, SharedAuthFilesystemOperation<GrokAuthReadResult>>()

type GrokAuthReadOptions = {
  home?: string | null
  signal?: AbortSignal
  timeoutMs?: number
}

/** Sanitize auth read failures before they reach renderer-visible account state. */
function getGrokAuthReadError(err: unknown): string {
  if (err instanceof SyntaxError) {
    return 'Grok auth file is invalid'
  }
  // Why: filesystem errors often include the full auth path; renderer/mobile
  // account state should not expose local usernames or custom GROK_HOME values.
  return 'Unable to read Grok auth file'
}

/** Validate and narrow one unknown `auth.json` entry that carries an access token. */
function parseAuthEntry(value: unknown): TokenizedGrokAuthEntry | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const entry = value as GrokAuthEntry
  if (typeof entry.key !== 'string' || entry.key.length === 0) {
    return null
  }
  return entry as TokenizedGrokAuthEntry
}

/** Parse an optional ISO expiry without letting malformed metadata reject the file. */
function parseExpiresAtMs(iso: string | undefined): number | null {
  if (!iso) {
    return null
  }
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

// Why: stale alternate issuers can precede the default xAI OAuth session in auth.json.
const PREFERRED_GROK_AUTH_ISSUER = 'https://auth.x.ai'

/** Convert Grok CLI's auth entry shape into Orca's normalized session contract. */
function sessionFromAuthEntry(authEntry: TokenizedGrokAuthEntry): GrokAuthSession {
  return {
    accessToken: authEntry.key,
    userId: typeof authEntry.user_id === 'string' ? authEntry.user_id : null,
    email: typeof authEntry.email === 'string' ? authEntry.email : null,
    teamId: typeof authEntry.team_id === 'string' ? authEntry.team_id : null,
    expiresAtMs: parseExpiresAtMs(authEntry.expires_at),
    oidcClientId: typeof authEntry.oidc_client_id === 'string' ? authEntry.oidc_client_id : null
  }
}

/** Identify xAI's preferred issuer while accepting its scoped session keys. */
function isPreferredGrokAuthKey(key: string): boolean {
  return key === PREFERRED_GROK_AUTH_ISSUER || key.startsWith(`${PREFERRED_GROK_AUTH_ISSUER}::`)
}

/** Parse Grok CLI auth contents and select the preferred usable session. */
function parseGrokAuthContents(raw: string): GrokAuthReadResult {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) {
      return { status: 'error', error: 'Grok auth file is invalid' }
    }
    let preferredKeySeen = false
    let expiredPreferred: GrokAuthSession | null = null
    let fallback: GrokAuthSession | null = null
    for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
      const isPreferred = isPreferredGrokAuthKey(key)
      preferredKeySeen ||= isPreferred
      const authEntry = parseAuthEntry(entry)
      if (!authEntry) {
        continue
      }
      const session = sessionFromAuthEntry(authEntry)
      if (isPreferred) {
        if (isGrokAccessTokenFresh(session)) {
          return { status: 'ok', session }
        }
        expiredPreferred ??= session
        continue
      }
      fallback ??= session
    }
    // Why: alternate issuers are compatibility fallbacks only when no default entry exists.
    const selectedSession = expiredPreferred ?? (preferredKeySeen ? null : fallback)
    if (selectedSession) {
      return { status: 'ok', session: selectedSession }
    }
    return { status: 'missing' }
  } catch (error) {
    return { status: 'error', error: getGrokAuthReadError(error) }
  }
}

/** Treat absent files and absent parent directories as a signed-out state. */
function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Share one bounded filesystem read per auth path until the native read settles. */
function getGrokAuthRead(path: string): SharedAuthFilesystemOperation<GrokAuthReadResult> {
  const existing = authReadByPath.get(path)
  if (existing) {
    return existing
  }
  // Why: a timed-out UNC read can keep a native thread occupied; share it until settlement.
  const read = createAuthFilesystemOperation(path, async (): Promise<GrokAuthReadResult> => {
    try {
      return parseGrokAuthContents(await readFile(path, 'utf-8'))
    } catch (error) {
      return isMissingPathError(error)
        ? { status: 'missing' }
        : { status: 'error', error: getGrokAuthReadError(error) }
    }
  })
  authReadByPath.set(path, read)
  const clearRead = (): void => {
    if (authReadByPath.get(path) === read) {
      authReadByPath.delete(path)
    }
  }
  void read.result.then(clearRead, clearRead)
  return read
}

/** Read Grok authentication from a resolved home with timeout and abort support. */
export async function readGrokAuthSession(
  options: GrokAuthReadOptions = {}
): Promise<GrokAuthReadResult> {
  const home = options.home === undefined ? getGrokHome() : options.home
  if (!home) {
    return { status: 'error', error: 'Unable to resolve Grok auth home' }
  }
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? AUTH_READ_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal
  try {
    return await getGrokAuthRead(getGrokAuthPath(home)).wait(signal)
  } catch (error) {
    return { status: 'error', error: getGrokAuthReadError(error) }
  }
}

const TOKEN_SKEW_MS = 5 * 60 * 1000

/** Report whether a token remains usable beyond the refresh safety margin. */
export function isGrokAccessTokenFresh(session: GrokAuthSession): boolean {
  if (session.expiresAtMs === null) {
    // Why: auth.json may lack expiry; a bad token still surfaces as billing HTTP 401.
    return true
  }
  return session.expiresAtMs - Date.now() > TOKEN_SKEW_MS
}
