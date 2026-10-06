import { existsSync } from 'node:fs'
import { z } from 'zod'
import SyncDatabase from '../../sqlite/sync-database'
import {
  cursorProfileReadFailure,
  type CursorDesktopProfileReadResult
} from '../cursor-profile-result'

const TOKEN_KEY = 'cursorAuth/accessToken'
const EMAIL_KEY = 'cursorAuth/cachedEmail'
const MEMBERSHIP_KEY = 'cursorAuth/stripeMembershipType'
const SUBSCRIPTION_KEY = 'cursorAuth/stripeSubscriptionStatus'
const OPEN_TIMEOUT_MS = 250

const rowsSchema = z.array(z.object({ key: z.unknown(), value: z.unknown() }).partial())

function valueAsString(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) {
    return value
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('utf8').trim() || null
  }
  return null
}

/**
 * Reads the Cursor IDE's stored session. Opens read-only in place; state.vscdb can be multi-GB
 * and its -wal can be too, so this runs only on the foreign SQLite reader worker.
 */
export function readCursorProfile(dbPath: string): CursorDesktopProfileReadResult {
  if (!existsSync(dbPath)) {
    return { status: 'missing' }
  }
  let db: SyncDatabase | null = null
  try {
    db = new SyncDatabase(dbPath, {
      readonly: true,
      fileMustExist: true,
      timeout: OPEN_TIMEOUT_MS
    })
    const rows = rowsSchema.parse(
      db
        .prepare('SELECT key, value FROM ItemTable WHERE key IN (?, ?, ?, ?)')
        .all(TOKEN_KEY, EMAIL_KEY, MEMBERSHIP_KEY, SUBSCRIPTION_KEY)
    )
    const byKey = new Map<string, string>()
    for (const row of rows) {
      const value = valueAsString(row.value)
      if (typeof row.key === 'string' && value) {
        byKey.set(row.key, value)
      }
    }
    return {
      status: 'ok',
      profile: {
        accessToken: byKey.get(TOKEN_KEY) ?? null,
        email: byKey.get(EMAIL_KEY) ?? null,
        membershipType: byKey.get(MEMBERSHIP_KEY) ?? null,
        subscriptionStatus: byKey.get(SUBSCRIPTION_KEY) ?? null
      }
    }
  } catch {
    return cursorProfileReadFailure()
  } finally {
    db?.close()
  }
}
