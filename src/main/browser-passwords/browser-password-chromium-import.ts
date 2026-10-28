import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  decryptChromiumEncryptedValue,
  cookieEncryptionVersion
} from '../browser/cookies/sources/browser-cookie-decryption'
import {
  CHROMIUM_BROWSERS,
  browserRootPath,
  isSafeBrowserProfileDirectory,
  type ChromiumBrowserDef
} from '../browser/cookies/sources/browser-cookie-detection-types'
import { getEncryptionKey } from '../browser/cookies/sources/browser-cookie-key'
import type { EncryptionKeyResult } from '../browser/cookies/sources/browser-cookie-sqlite'
import { createChromiumCookieSnapshot } from '../browser/chromium-cookie-snapshot'
import type { BrowserPasswordImportRow } from './browser-password-import-merge'

/** The local and the account (Google-synced) password stores; a profile may have either or both. */
const LOGIN_DATABASE_FILES = ['Login Data', 'Login Data For Account'] as const

// Chrome stores times as microseconds since 1601-01-01 UTC.
const CHROME_EPOCH_OFFSET_MS = 11_644_473_600_000n

// PasswordForm::Scheme::kHtml; the others are HTTP auth and Android credentials.
const HTML_FORM_SCHEME = 0

export type ChromiumBrowserPasswordsFailureReason =
  | 'unsupported-browser'
  | 'invalid-profile'
  | 'not-found'
  | 'copy-failed'
  | 'read-failed'
  | 'key-unavailable'

export type ChromiumBrowserPasswordsResult =
  | { ok: true; rows: BrowserPasswordImportRow[]; undecryptable: number }
  | { ok: false; reason: ChromiumBrowserPasswordsFailureReason; message: string }

type RawLogin = {
  originUrl: string
  username: string
  encryptedPassword: Buffer
  createdAt: number | undefined
}

type ReadLoginsResult =
  | { ok: true; logins: RawLogin[] }
  | { ok: false; reason: 'copy-failed' | 'read-failed' }

function toEpochMs(chromeTime: unknown): number | undefined {
  if (typeof chromeTime !== 'bigint' || chromeTime <= 0n) {
    return undefined
  }
  const ms = Number(chromeTime / 1000n - CHROME_EPOCH_OFFSET_MS)
  return ms > 0 ? ms : undefined
}

function readLoginRows(databasePath: string): RawLogin[] {
  // Why readBigInts: Chrome timestamps can exceed Number.MAX_SAFE_INTEGER.
  const database = new DatabaseSync(databasePath, { readOnly: true, readBigInts: true })
  try {
    const columns = new Set(
      database
        .prepare('PRAGMA table_info(logins)')
        .all()
        .map((column) => column.name)
    )
    const has = (name: string): boolean => columns.has(name)
    if (!has('origin_url') || !has('username_value') || !has('password_value')) {
      throw new Error('logins table is missing required columns')
    }
    const select = [
      'origin_url',
      'username_value',
      'password_value',
      has('blacklisted_by_user') ? 'blacklisted_by_user' : '0 AS blacklisted_by_user',
      has('scheme') ? 'scheme' : `${HTML_FORM_SCHEME} AS scheme`,
      has('date_created') ? 'date_created' : '0 AS date_created'
    ].join(', ')
    const logins: RawLogin[] = []
    for (const row of database.prepare(`SELECT ${select} FROM logins`).all()) {
      const { origin_url, username_value, password_value, blacklisted_by_user, scheme } = row
      // "Never save" rows carry no password; non-HTML schemes are not web form logins.
      if (Number(blacklisted_by_user) !== 0 || Number(scheme) !== HTML_FORM_SCHEME) {
        continue
      }
      if (typeof origin_url !== 'string' || !(password_value instanceof Uint8Array)) {
        continue
      }
      // An empty blob is a federated (e.g. Google sign-in) credential: there is no password.
      if (password_value.length === 0) {
        continue
      }
      logins.push({
        originUrl: origin_url,
        username: typeof username_value === 'string' ? username_value : '',
        encryptedPassword: Buffer.from(password_value),
        createdAt: toEpochMs(row.date_created)
      })
    }
    return logins
  } finally {
    database.close()
  }
}

function readLoginDatabase(sourcePath: string, fileName: string): ReadLoginsResult {
  let snapshot: ReturnType<typeof createChromiumCookieSnapshot>
  try {
    // Why a snapshot: an open browser may hold recent logins only in the WAL.
    snapshot = createChromiumCookieSnapshot(sourcePath, { fileName })
  } catch {
    return { ok: false, reason: 'copy-failed' }
  }
  try {
    return { ok: true, logins: readLoginRows(snapshot.databasePath) }
  } catch {
    return { ok: false, reason: 'read-failed' }
  } finally {
    snapshot.cleanup()
  }
}

/** Never attempts v20 (app-bound) values; those, and any value that fails to decrypt, are counted. */
function decryptLogins(
  logins: readonly RawLogin[],
  key: EncryptionKeyResult | null
): { rows: BrowserPasswordImportRow[]; undecryptable: number } {
  const rows: BrowserPasswordImportRow[] = []
  const seen = new Set<string>()
  let undecryptable = 0
  for (const login of logins) {
    const version = cookieEncryptionVersion(login.encryptedPassword)
    const decrypted =
      key && (version === 'v10' || version === 'v11')
        ? decryptChromiumEncryptedValue(login.encryptedPassword, key)
        : null
    if (!decrypted) {
      undecryptable += 1
      continue
    }
    const password = decrypted.toString('utf8')
    // Both login databases often hold the same login; keep one copy.
    const identity = JSON.stringify([login.originUrl, login.username, password])
    if (seen.has(identity)) {
      continue
    }
    seen.add(identity)
    rows.push({
      origin: login.originUrl,
      username: login.username,
      password,
      ...(login.createdAt === undefined ? {} : { createdAt: login.createdAt })
    })
  }
  return { rows, undecryptable }
}

function needsKey(logins: readonly RawLogin[]): boolean {
  return logins.some((login) => {
    const version = cookieEncryptionVersion(login.encryptedPassword)
    return version === 'v10' || version === 'v11'
  })
}

/** Reads saved logins from a Chromium-family profile on the machine Orca's UI runs on. */
export async function readChromiumBrowserPasswords(input: {
  browserFamily: ChromiumBrowserDef['family']
  profileDirectory: string
}): Promise<ChromiumBrowserPasswordsResult> {
  const def = CHROMIUM_BROWSERS.find((browser) => browser.family === input.browserFamily)
  const root = def ? browserRootPath(def) : null
  if (!def || !root) {
    return {
      ok: false,
      reason: 'unsupported-browser',
      message: 'This browser is not supported on this platform.'
    }
  }
  if (!isSafeBrowserProfileDirectory(input.profileDirectory)) {
    return { ok: false, reason: 'invalid-profile', message: `Invalid ${def.label} profile.` }
  }
  const sources = LOGIN_DATABASE_FILES.map((fileName) => ({
    fileName,
    path: join(root, input.profileDirectory, fileName)
  })).filter((source) => existsSync(source.path))
  if (sources.length === 0) {
    return { ok: false, reason: 'not-found', message: `No saved passwords found in ${def.label}.` }
  }

  const logins: RawLogin[] = []
  for (const source of sources) {
    const read = readLoginDatabase(source.path, source.fileName)
    if (!read.ok) {
      return {
        ok: false,
        reason: read.reason,
        message:
          read.reason === 'copy-failed'
            ? `Could not copy ${def.label} saved passwords. Try closing ${def.label} first.`
            : `Could not read ${def.label} saved passwords.`
      }
    }
    logins.push(...read.logins)
  }

  const keyNeeded = needsKey(logins)
  const key = keyNeeded
    ? await getEncryptionKey(def.keychainService, def.keychainAccount, { family: def.family })
    : null
  if (keyNeeded && !key) {
    return {
      ok: false,
      reason: 'key-unavailable',
      message: `Could not access ${def.label} encryption key. The OS may have denied access.`
    }
  }
  return { ok: true, ...decryptLogins(logins, key) }
}
