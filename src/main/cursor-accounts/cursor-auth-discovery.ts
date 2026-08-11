import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import SyncDatabase from '../sqlite/sync-database'

/** Read-only view of the account signed into Cursor, sourced from Cursor's
 *  own `state.vscdb` (`ItemTable` keys `cursorAuth/*`). Orca never writes here. */
export type CursorDiscoveredAccount = {
  email: string
  authId: string | null
  membershipType: string | null
  signUpType: string | null
  subscriptionStatus: string | null
  configDbPath: string
}

/** Cursor stores its global state under the OS app-data dir. `appDataDir` is
 *  Electron's `app.getPath('appData')`: Roaming on Windows, Application Support
 *  on macOS, ~/.config on Linux — the parent of every VS Code-family app dir. */
export function resolveCursorStateDbPath(appDataDir: string): string {
  return join(appDataDir, 'Cursor', 'User', 'globalStorage', 'state.vscdb')
}

/** Stable id for a Cursor identity so repeated scans map to the same account. */
export function cursorAccountId(authId: string | null, email: string): string {
  const seed = authId && authId.length > 0 ? authId : email
  return `cursor-${createHash('sha256').update(seed).digest('hex').slice(0, 16)}`
}

function readItem(db: InstanceType<typeof SyncDatabase>, key: string): string | null {
  const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key) as
    | { value: string | Uint8Array | null }
    | undefined
  if (!row || row.value === null || row.value === undefined) {
    return null
  }
  const value = typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('utf8')
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Reads the signed-in Cursor account, or null when Cursor is absent/signed out.
 *  Never throws — a locked or malformed DB yields null so account listing degrades
 *  gracefully. `state.vscdb` can be large, so we open read-only and query by key. */
export function discoverCursorAccount(dbPath: string): CursorDiscoveredAccount | null {
  if (!existsSync(dbPath)) {
    return null
  }
  let db: InstanceType<typeof SyncDatabase> | null = null
  try {
    db = new SyncDatabase(dbPath, { readonly: true, fileMustExist: true })
    const email = readItem(db, 'cursorAuth/cachedEmail')
    if (!email) {
      return null
    }
    return {
      email,
      authId: readItem(db, 'glass.lastSignedInAuthId'),
      membershipType: readItem(db, 'cursorAuth/stripeMembershipType'),
      signUpType: readItem(db, 'cursorAuth/cachedSignUpType'),
      subscriptionStatus: readItem(db, 'cursorAuth/stripeSubscriptionStatus'),
      configDbPath: dbPath
    }
  } catch {
    return null
  } finally {
    db?.close()
  }
}
