import { existsSync } from 'node:fs'
import { z } from 'zod'
import SyncDatabase from '../../sqlite/sync-database'
import {
  kiroCliCredentialsReadFailure,
  type KiroCliCredentialsReadResult
} from '../kiro-cli-credentials-result'

const TOKEN_KEY = 'kirocli:odic:token'
const PROFILE_KEY = 'api.codewhisperer.profile'
const OPEN_TIMEOUT_MS = 250

const rowSchema = z.object({ value: z.unknown() }).partial().optional()
// Unknown keys (refresh_token included) are dropped by the parse.
const tokenSchema = z.object({ access_token: z.string().min(1), expires_at: z.string().optional() })
const profileSchema = z.object({ arn: z.string().min(1) })

function rowValueAsText(row: unknown): string | null {
  const value = rowSchema.parse(row)?.value
  if (typeof value === 'string' && value.length > 0) {
    return value
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('utf8').trim() || null
  }
  return null
}

/**
 * Read kiro-cli's stored login read-only. Open only in a worker: kiro-cli holds this database open.
 * @param dbPath - kiro-cli's data.sqlite3.
 * @returns `missing` when kiro-cli has no database or login, `ok`, or `error` when unreadable.
 */
export function readKiroCliCredentials(dbPath: string): KiroCliCredentialsReadResult {
  if (!existsSync(dbPath)) {
    return { status: 'missing' }
  }
  let db: SyncDatabase | null = null
  try {
    db = new SyncDatabase(dbPath, { readonly: true, fileMustExist: true, timeout: OPEN_TIMEOUT_MS })
    const tokenText = rowValueAsText(
      db.prepare('SELECT value FROM auth_kv WHERE key = ?').get(TOKEN_KEY)
    )
    const profileText = rowValueAsText(
      db.prepare('SELECT value FROM state WHERE key = ?').get(PROFILE_KEY)
    )
    // A logged-out kiro-cli removes its token row; that is "not signed in", not a read failure.
    if (tokenText === null || profileText === null) {
      return { status: 'missing' }
    }
    const token = tokenSchema.parse(JSON.parse(tokenText))
    const profile = profileSchema.parse(JSON.parse(profileText))
    return {
      status: 'ok',
      credentials: {
        accessToken: token.access_token,
        expiresAt: token.expires_at ?? null,
        profileArn: profile.arn
      }
    }
  } catch {
    return kiroCliCredentialsReadFailure()
  } finally {
    db?.close()
  }
}
