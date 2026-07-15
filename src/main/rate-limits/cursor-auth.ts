import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const ACCESS_TOKEN_KEY = 'cursorAuth/accessToken'
const EMAIL_KEY = 'cursorAuth/cachedEmail'
const MEMBERSHIP_KEY = 'cursorAuth/stripeMembershipType'
const REFRESH_TOKEN_KEY = 'cursorAuth/refreshToken'

export type CursorAuthSession = {
  accessToken: string
  refreshToken: string | null
  email: string | null
  membershipType: string | null
}

export type CursorAuthReadResult =
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; session: CursorAuthSession }

export type CursorAuthPathOptions = {
  /** Override the state.vscdb path (tests). */
  stateDbPath?: string
  /** Override temp root used when copying a locked DB (tests). */
  tempRoot?: string
}

// Why: Cursor stores OAuth tokens in the IDE globalStorage SQLite DB, not a
// plain JSON file like Grok — path must match each platform's Cursor install.
export function getCursorStateDbPath(): string {
  const home = homedir()
  if (process.platform === 'darwin') {
    return join(
      home,
      'Library',
      'Application Support',
      'Cursor',
      'User',
      'globalStorage',
      'state.vscdb'
    )
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming')
    return join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb')
  }
  return join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
}

function getCursorAuthReadError(_err: unknown): string {
  // Why: filesystem/sqlite errors often include the full home path; keep the
  // status-bar error free of usernames.
  return 'Unable to read Cursor auth'
}

function readItemValue(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key) as
    | { value: string | Uint8Array | null }
    | undefined
  if (!row || row.value == null) {
    return null
  }
  if (typeof row.value === 'string') {
    return row.value
  }
  if (row.value instanceof Uint8Array) {
    return Buffer.from(row.value).toString('utf8')
  }
  return String(row.value)
}

function readSessionFromDb(dbPath: string): CursorAuthReadResult {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const accessToken = readItemValue(db, ACCESS_TOKEN_KEY)?.trim() ?? ''
    if (!accessToken) {
      // Why: logged-out Cursor still has the DB; treat as unsigned-in, not error.
      return { status: 'missing' }
    }
    const refreshToken = readItemValue(db, REFRESH_TOKEN_KEY)?.trim() || null
    const email = readItemValue(db, EMAIL_KEY)?.trim() || null
    const membershipType = readItemValue(db, MEMBERSHIP_KEY)?.trim() || null
    return {
      status: 'ok',
      session: {
        accessToken,
        refreshToken,
        email,
        membershipType
      }
    }
  } finally {
    db.close()
  }
}

function removeSnapshotDir(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
}

function readSessionViaTempCopy(
  sourcePath: string,
  tempRoot: string | undefined
): CursorAuthReadResult {
  const snapshotDir = mkdtempSync(join(tempRoot ?? tmpdir(), 'orca-cursor-auth-'))
  const copyPath = join(snapshotDir, 'state.vscdb')
  try {
    copyFileSync(sourcePath, copyPath)
    // Why: WAL sidecars may exist while Cursor is open; best-effort copy keeps
    // a consistent view without failing when they are locked/missing.
    for (const suffix of ['-wal', '-shm'] as const) {
      const side = `${sourcePath}${suffix}`
      if (existsSync(side)) {
        try {
          copyFileSync(side, `${copyPath}${suffix}`)
        } catch {
          /* ignore locked/missing sidecars */
        }
      }
    }
    return readSessionFromDb(copyPath)
  } finally {
    removeSnapshotDir(snapshotDir)
  }
}

export function readCursorAuthSession(options: CursorAuthPathOptions = {}): CursorAuthReadResult {
  const path = options.stateDbPath ?? getCursorStateDbPath()
  if (!existsSync(path)) {
    return { status: 'missing' }
  }
  try {
    return readSessionFromDb(path)
  } catch (directErr) {
    // Why: Windows often locks state.vscdb while Cursor is running; a temp copy
    // is the durable fallback used elsewhere for Chromium cookie DBs.
    try {
      return readSessionViaTempCopy(path, options.tempRoot)
    } catch {
      return {
        status: 'error',
        error: getCursorAuthReadError(directErr)
      }
    }
  }
}

export function hasCursorAuthSession(options?: CursorAuthPathOptions): boolean {
  return readCursorAuthSession(options).status === 'ok'
}
