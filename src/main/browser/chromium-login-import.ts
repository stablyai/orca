import { DatabaseSync } from 'node:sqlite'
import { decryptChromiumValue, type EncryptionKeyResult } from './chromium-value-decrypt'

export type ChromiumLoginRecord = { origin: string; username: string; password: string }

type LoginRow = {
  origin_url?: string
  username_value?: string
  // Why: node:sqlite returns BLOB columns as Uint8Array (matches browser-cookie-import.ts
  // pattern: `encRaw instanceof Uint8Array ? Buffer.from(encRaw) : null`).
  password_value?: Uint8Array | null
  blacklisted_by_user?: number | bigint
}

export function readChromiumLogins(
  dbPath: string,
  keyResult: EncryptionKeyResult
): ChromiumLoginRecord[] {
  // Why: open read-only so we never modify the live Login Data file; the caller
  // is responsible for providing a temp copy if the browser may have a lock.
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const rows = db
      .prepare('SELECT origin_url, username_value, password_value, blacklisted_by_user FROM logins')
      .all() as LoginRow[]
    const out: ChromiumLoginRecord[] = []
    for (const row of rows) {
      try {
        // Why: Chromium sets blacklisted_by_user=1 for "never save" entries; drop them.
        if (Number(row.blacklisted_by_user ?? 0) === 1) {
          continue
        }
        const origin = row.origin_url ?? ''
        const username = row.username_value ?? ''
        const enc = row.password_value
        if (!origin || !enc || enc.length === 0) {
          continue
        }
        const decrypted = decryptChromiumValue(Buffer.from(enc), keyResult)
        if (!decrypted) {
          continue
        }
        const password = decrypted.toString('utf8')
        // Why: rows with neither a username nor a password carry no useful
        // credential — they're leftover form-field observations.
        if (username === '' && password === '') {
          continue
        }
        out.push({ origin, username, password })
      } catch {
        // Why: a single malformed/undecryptable row must not abort the whole import.
      }
    }
    return out
  } finally {
    db.close()
  }
}
