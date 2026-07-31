import { existsSync } from 'node:fs'
import SyncDatabase from '../sqlite/sync-database'
import {
  CURSOR_ACCESS_TOKEN_KEY,
  CURSOR_CACHED_EMAIL_KEY,
  resolveCursorGlobalStateDbPath
} from '../../shared/cursor-session-paths'

export type CursorAuthSession = {
  accessToken: string
  userId: string
  email: string | null
  expiresAtMs: number | null
}

export type CursorAuthReadResult =
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; session: CursorAuthSession }

const TOKEN_SKEW_MS = 60_000

function decodeJwtPayload(accessToken: string): Record<string, unknown> | null {
  const parts = accessToken.split('.')
  if (parts.length < 2) {
    return null
  }
  let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
  payload += '='.repeat((4 - (payload.length % 4)) % 4)
  try {
    const json = Buffer.from(payload, 'base64').toString('utf8')
    const parsed: unknown = JSON.parse(json)
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function parseUserIdFromToken(accessToken: string): string | null {
  const payload = decodeJwtPayload(accessToken)
  if (!payload) {
    return null
  }
  const subject = payload.sub
  if (typeof subject !== 'string') {
    return null
  }
  const userId = subject.split('|').pop()?.trim()
  if (!userId || !/^[A-Za-z0-9._-]+$/.test(userId)) {
    return null
  }
  return userId
}

function parseExpiresAtMs(accessToken: string): number | null {
  const payload = decodeJwtPayload(accessToken)
  if (!payload) {
    return null
  }
  const exp = payload.exp
  if (typeof exp === 'number' && Number.isFinite(exp)) {
    return exp * 1000
  }
  return null
}

export function buildCursorCookieHeader(session: CursorAuthSession): string {
  return `WorkosCursorSessionToken=${session.userId}%3A%3A${session.accessToken}`
}

export function sessionFromAccessToken(
  accessToken: string,
  email: string | null = null
): CursorAuthSession | null {
  const trimmed = accessToken.trim()
  if (!trimmed) {
    return null
  }
  const userId = parseUserIdFromToken(trimmed)
  if (!userId) {
    return null
  }
  return {
    accessToken: trimmed,
    userId,
    email,
    expiresAtMs: parseExpiresAtMs(trimmed)
  }
}

export function isCursorAccessTokenFresh(session: CursorAuthSession): boolean {
  if (session.expiresAtMs === null) {
    return true
  }
  return session.expiresAtMs - Date.now() > TOKEN_SKEW_MS
}

function readItemFromStateDb(dbPath: string, key: string): string | null {
  let db: SyncDatabase.Database | null = null
  try {
    db = new SyncDatabase(dbPath, { readonly: true, fileMustExist: true })
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key) as
      | { value?: string }
      | undefined
    const value = row?.value
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
  } catch {
    return null
  } finally {
    db?.close()
  }
}

export function readCursorAuthSession(): CursorAuthReadResult {
  const dbPath = resolveCursorGlobalStateDbPath()
  if (!existsSync(dbPath)) {
    return { status: 'missing' }
  }
  const accessToken = readItemFromStateDb(dbPath, CURSOR_ACCESS_TOKEN_KEY)
  if (!accessToken) {
    return { status: 'missing' }
  }
  const session = sessionFromAccessToken(
    accessToken,
    readItemFromStateDb(dbPath, CURSOR_CACHED_EMAIL_KEY)
  )
  if (!session) {
    return { status: 'error', error: 'Cursor sign-in token is invalid' }
  }
  return { status: 'ok', session }
}

export function hasCursorAuthSession(): boolean {
  return readCursorAuthSession().status === 'ok'
}
