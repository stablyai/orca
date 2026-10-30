import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveGrokHomeDir } from '../../shared/grok-session-paths'

export function getGrokHome(): string {
  return resolveGrokHomeDir()
}

export function getGrokAuthPath(): string {
  return join(getGrokHome(), 'auth.json')
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

function getGrokAuthReadError(err: unknown): string {
  if (err instanceof SyntaxError) {
    return 'Grok auth file is invalid'
  }
  // Keep filesystem paths/usernames out of renderer and mobile account state.
  return 'Unable to read Grok auth file'
}

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

function parseExpiresAtMs(iso: string | undefined): number | null {
  if (!iso) {
    return null
  }
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

// Prefer default xAI OAuth over stale alternate issuers.
const PREFERRED_GROK_AUTH_ISSUER = 'https://auth.x.ai'

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

function isPreferredGrokAuthKey(key: string): boolean {
  return key === PREFERRED_GROK_AUTH_ISSUER || key.startsWith(`${PREFERRED_GROK_AUTH_ISSUER}::`)
}

export function readGrokAuthSession(): GrokAuthReadResult {
  const path = getGrokAuthPath()
  if (!existsSync(path)) {
    return { status: 'missing' }
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
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
      if (!fallback) {
        fallback = session
      }
    }
    // Alternate issuers are fallback only when no default entry exists.
    const selectedSession = expiredPreferred ?? (preferredKeySeen ? null : fallback)
    if (selectedSession) {
      return { status: 'ok', session: selectedSession }
    }
    // A tokenless logout is missing auth, not a persistent status-bar error.
    return { status: 'missing' }
  } catch (err) {
    return {
      status: 'error',
      error: getGrokAuthReadError(err)
    }
  }
}

const TOKEN_SKEW_MS = 5 * 60 * 1000

export function isGrokAccessTokenFresh(session: GrokAuthSession): boolean {
  if (session.expiresAtMs === null) {
    // Missing expiry is inconclusive; the billing endpoint can still reject the token.
    return true
  }
  return session.expiresAtMs - Date.now() > TOKEN_SKEW_MS
}
