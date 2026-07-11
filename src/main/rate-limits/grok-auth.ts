import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveGrokHomeDir } from '../../shared/grok-session-paths'

// Why: when GROK_HOME is set, auth.json must be the same path Grok CLI uses.
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

export type GrokAuthReadResult =
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; session: GrokAuthSession }

function getGrokAuthReadError(err: unknown): string {
  if (err instanceof SyntaxError) {
    return 'Grok auth file is invalid'
  }
  // Why: filesystem errors often include the full auth path; renderer/mobile
  // account state should not expose local usernames or custom GROK_HOME values.
  return 'Unable to read Grok auth file'
}

function parseAuthEntry(value: unknown): GrokAuthEntry | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const entry = value as GrokAuthEntry
  if (typeof entry.key !== 'string' || entry.key.length === 0) {
    return null
  }
  return entry
}

function parseExpiresAtMs(iso: string | undefined): number | null {
  if (!iso) {
    return null
  }
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
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
    for (const entry of Object.values(parsed)) {
      const authEntry = parseAuthEntry(entry)
      if (!authEntry?.key) {
        continue
      }
      return {
        status: 'ok',
        session: {
          accessToken: authEntry.key,
          userId: typeof authEntry.user_id === 'string' ? authEntry.user_id : null,
          email: typeof authEntry.email === 'string' ? authEntry.email : null,
          teamId: typeof authEntry.team_id === 'string' ? authEntry.team_id : null,
          expiresAtMs: parseExpiresAtMs(authEntry.expires_at),
          oidcClientId:
            typeof authEntry.oidc_client_id === 'string' ? authEntry.oidc_client_id : null
        }
      }
    }
    // Why: a token-less file (e.g. after grok logout) means signed out, not a
    // failure — 'error' would keep a status-bar alert visible for that user.
    return { status: 'missing' }
  } catch (err) {
    return {
      status: 'error',
      error: getGrokAuthReadError(err)
    }
  }
}

export function hasGrokAuthSession(): boolean {
  return readGrokAuthSession().status === 'ok'
}

const TOKEN_SKEW_MS = 5 * 60 * 1000

export function isGrokAccessTokenFresh(session: GrokAuthSession): boolean {
  if (session.expiresAtMs === null) {
    // Why: auth.json may lack expiry; a bad token still surfaces as billing HTTP 401.
    return true
  }
  return session.expiresAtMs - Date.now() > TOKEN_SKEW_MS
}
