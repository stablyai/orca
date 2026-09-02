import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserCookieImportResult } from '../../shared/browser-workspace-types'
import { readFirefoxRowPartition } from './browser-cookie-source-partition'
import {
  importValidatedCookies,
  cookieImportTarget,
  type CookieImportOptions
} from './browser-cookie-import-pipeline'
import { deriveUrl, firefoxSameSite, type ValidatedCookie } from './browser-cookie-validation'
import type { DetectedBrowser } from './browser-cookie-detection-types'
import { diag } from './browser-cookie-import-diagnostics'

// ---------------------------------------------------------------------------
// Firefox import
// ---------------------------------------------------------------------------

export async function importCookiesFromFirefox(
  browser: DetectedBrowser,
  targetPartition: string,
  options: CookieImportOptions
): Promise<BrowserCookieImportResult> {
  diag(`importCookiesFromFirefox: partition="${targetPartition}"`)

  const tmpDir = mkdtempSync(join(tmpdir(), 'orca-cookie-import-'))
  const tmpCookiesPath = join(tmpDir, 'cookies.sqlite')

  try {
    copyFileSync(browser.cookiesPath, tmpCookiesPath)
    for (const suffix of ['-wal', '-shm'] as const) {
      const sidecar = browser.cookiesPath + suffix
      if (existsSync(sidecar)) {
        try {
          copyFileSync(sidecar, tmpCookiesPath + suffix)
        } catch {
          /* best-effort */
        }
      }
    }
  } catch {
    rmSync(tmpDir, { recursive: true, force: true })
    return {
      ok: false,
      reason: 'Could not copy Firefox cookies database. Try closing Firefox first.'
    }
  }

  try {
    const db = new DatabaseSync(tmpCookiesPath, { readOnly: true })
    type FirefoxRow = Record<string, unknown> & {
      name: string
      value: string
      host: string
      path: string
      expiry: number
      isSecure: number
      isHttpOnly: number
      sameSite: number
      isPartitionedAttributeSet?: number
    }
    // Why: selecting a column an older moz_cookies schema lacks fails the whole import. A schema
    // without the server-declared partition flag predates that cookie identity.
    const firefoxColumns = new Set(
      (db.prepare('PRAGMA table_info(moz_cookies)').all() as { name: string }[]).map(
        (column) => column.name
      )
    )
    const partitionColumn = firefoxColumns.has('isPartitionedAttributeSet')
      ? ', isPartitionedAttributeSet'
      : ''
    const rows = db
      .prepare(
        `SELECT name, value, host, path, expiry, isSecure, isHttpOnly, sameSite${partitionColumn} FROM moz_cookies`
      )
      .all() as FirefoxRow[]
    db.close()

    diag(`  Firefox source has ${rows.length} cookies`)
    if (rows.length === 0) {
      rmSync(tmpDir, { recursive: true, force: true })
      return { ok: false, reason: 'No cookies found in Firefox.' }
    }

    const now = Math.floor(Date.now() / 1000)
    const validated: ValidatedCookie[] = []
    for (const row of rows) {
      if (!row.name || !row.host) {
        continue
      }
      if (row.expiry > 0 && row.expiry < now) {
        continue
      }

      const domain = row.host
      const secure = row.isSecure === 1
      const url = deriveUrl(domain, secure)
      if (!url) {
        continue
      }

      validated.push({
        url,
        name: row.name,
        value: row.value ?? '',
        domain,
        path: row.path || '/',
        secure,
        httpOnly: row.isHttpOnly === 1,
        sameSite: firefoxSameSite(row.sameSite),
        expirationDate: row.expiry > 0 ? row.expiry : undefined,
        partition: readFirefoxRowPartition(row, firefoxColumns)
      })
    }

    rmSync(tmpDir, { recursive: true, force: true })

    if (validated.length === 0) {
      return { ok: false, reason: 'No valid cookies found in Firefox.' }
    }

    return importValidatedCookies(
      validated,
      rows.length,
      cookieImportTarget(targetPartition),
      'replace-imported-domains',
      options
    )
  } catch (err) {
    rmSync(tmpDir, { recursive: true, force: true })
    diag(`  Firefox import failed: ${String(err)}`)
    return {
      ok: false,
      reason: 'Could not import cookies from Firefox. Try closing Firefox first.'
    }
  }
}
