import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import SyncDatabase from '../sqlite/sync-database'

const DESKTOP_TOKEN_KEY = 'cursorAuth/accessToken'
const DESKTOP_EMAIL_KEY = 'cursorAuth/cachedEmail'
const DESKTOP_MEMBERSHIP_KEY = 'cursorAuth/stripeMembershipType'
const DESKTOP_SUBSCRIPTION_KEY = 'cursorAuth/stripeSubscriptionStatus'
const SQLITE_OPEN_TIMEOUT_MS = 250

export type CursorAuthSource = 'desktop' | 'cli'

export type CursorAuthSession = {
  accessToken: string
  subject: string
  source: CursorAuthSource
  email: string | null
  membershipType: string | null
  subscriptionStatus: string | null
}

export type CursorAuthReadResult =
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; session: CursorAuthSession }

function cursorConfigRoot(source: CursorAuthSource): string {
  if (process.platform === 'darwin') {
    return source === 'desktop'
      ? join(homedir(), 'Library', 'Application Support', 'Cursor')
      : join(homedir(), '.cursor')
  }
  if (process.platform === 'win32') {
    const root = process.env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming')
    return join(root, 'Cursor')
  }
  const root = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config')
  return join(root, source === 'desktop' ? 'Cursor' : 'cursor')
}

export function getCursorDesktopStateDbPath(): string {
  return join(cursorConfigRoot('desktop'), 'User', 'globalStorage', 'state.vscdb')
}

export function getCursorCliAuthPath(): string {
  // Why: mirrors Cursor Agent's credential manager path calculation.
  return join(cursorConfigRoot('cli'), 'auth.json')
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length < 2 || !parts[1]) {
    return null
  }
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const pad = '='.repeat((4 - (padded.length % 4)) % 4)
    const parsed: unknown = JSON.parse(Buffer.from(padded + pad, 'base64').toString('utf8'))
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export function jwtSubject(token: string): string | null {
  const sub = decodeJwtPayload(token)?.sub
  return typeof sub === 'string' && sub.trim().length > 0 ? sub.trim() : null
}

export function cursorUsageSummaryCookie(token: string): string | null {
  const sub = jwtSubject(token)
  return sub ? `WorkosCursorSessionToken=${encodeURIComponent(sub)}%3A%3A${token}` : null
}

function valueAsString(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) {
    return value
  }
  if (value instanceof Uint8Array) {
    const text = Buffer.from(value).toString('utf8').trim()
    return text || null
  }
  return null
}

type DesktopProfile = {
  accessToken: string | null
  email: string | null
  membershipType: string | null
  subscriptionStatus: string | null
}

type DesktopProfileReadResult =
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; profile: DesktopProfile }

type CliTokenReadResult =
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; token: string }

function emptyProfile(): DesktopProfile {
  return { accessToken: null, email: null, membershipType: null, subscriptionStatus: null }
}

function readDesktopProfile(dbPath: string): DesktopProfileReadResult {
  // Why: state.vscdb can be multi-GB, so open it read-only in place and never copy it.
  if (!existsSync(dbPath)) {
    return { status: 'missing' }
  }
  let db: SyncDatabase | null = null
  try {
    db = new SyncDatabase(dbPath, {
      readonly: true,
      fileMustExist: true,
      timeout: SQLITE_OPEN_TIMEOUT_MS
    })
    const rows = db
      .prepare('SELECT key, value FROM ItemTable WHERE key IN (?, ?, ?, ?)')
      .all(
        DESKTOP_TOKEN_KEY,
        DESKTOP_EMAIL_KEY,
        DESKTOP_MEMBERSHIP_KEY,
        DESKTOP_SUBSCRIPTION_KEY
      ) as { key?: unknown; value?: unknown }[]
    const byKey = new Map<string, string>()
    for (const row of rows) {
      if (typeof row.key !== 'string') {
        continue
      }
      const value = valueAsString(row.value)
      if (value) {
        byKey.set(row.key, value)
      }
    }
    return {
      status: 'ok',
      profile: {
        accessToken: byKey.get(DESKTOP_TOKEN_KEY) ?? null,
        email: byKey.get(DESKTOP_EMAIL_KEY) ?? null,
        membershipType: byKey.get(DESKTOP_MEMBERSHIP_KEY) ?? null,
        subscriptionStatus: byKey.get(DESKTOP_SUBSCRIPTION_KEY) ?? null
      }
    }
  } catch {
    return { status: 'error', error: 'Unable to read Cursor desktop auth' }
  } finally {
    db?.close()
  }
}

function readCliAccessToken(authPath: string): CliTokenReadResult {
  if (!existsSync(authPath)) {
    return { status: 'missing' }
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(authPath, 'utf8'))
    const token =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { accessToken?: unknown }).accessToken
        : null
    return typeof token === 'string' && token.length > 0
      ? { status: 'ok', token }
      : { status: 'missing' }
  } catch (error) {
    return {
      status: 'error',
      error:
        error instanceof SyntaxError
          ? 'Cursor Agent auth file is invalid'
          : 'Unable to read Cursor Agent auth file'
    }
  }
}

function sessionFromToken(
  token: string,
  source: CursorAuthSource,
  profile: Pick<DesktopProfile, 'email' | 'membershipType' | 'subscriptionStatus'>
): CursorAuthSession | null {
  const subject = jwtSubject(token)
  return subject ? { accessToken: token, subject, source, ...profile } : null
}

export function readCursorAuthSession(): CursorAuthReadResult {
  const desktopPath = getCursorDesktopStateDbPath()
  const cliPath = getCursorCliAuthPath()
  // Why: most hosts have no Cursor install; keep service construction and polls off SQLite entirely.
  if (!existsSync(desktopPath) && !existsSync(cliPath)) {
    return { status: 'missing' }
  }
  const desktopRead = readDesktopProfile(desktopPath)
  if (desktopRead.status === 'error') {
    return desktopRead
  }
  const profile = desktopRead.status === 'ok' ? desktopRead.profile : emptyProfile()
  const desktop = profile.accessToken
    ? sessionFromToken(profile.accessToken, 'desktop', profile)
    : null
  if (desktop) {
    return { status: 'ok', session: desktop }
  }

  const cliRead = readCliAccessToken(cliPath)
  if (cliRead.status === 'error') {
    return cliRead
  }
  const cli =
    cliRead.status === 'ok'
      ? sessionFromToken(cliRead.token, 'cli', {
          email: null,
          membershipType: null,
          subscriptionStatus: null
        })
      : null
  return cli ? { status: 'ok', session: cli } : { status: 'missing' }
}
