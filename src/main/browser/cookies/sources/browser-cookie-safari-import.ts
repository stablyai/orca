import { readFileSync } from 'node:fs'
import { browserCookieImportFailure } from '../../../../shared/browser-cookie-import-failure-copy'
import type { BrowserCookieImportResult } from '../../../../shared/browser-workspace-types'
import { decodeSafariBinaryCookies } from './browser-cookie-safari-parser'
import { importValidatedCookies, cookieImportTarget } from '../browser-cookie-import-pipeline'
import type { DetectedBrowser } from './browser-cookie-detection-types'
import { diag } from '../browser-cookie-import-diagnostics'

export async function importCookiesFromSafari(
  browser: DetectedBrowser,
  targetPartition: string
): Promise<BrowserCookieImportResult> {
  diag(`importCookiesFromSafari: partition="${targetPartition}"`)

  let data: Buffer
  try {
    data = readFileSync(browser.cookiesPath)
  } catch (err) {
    diag(`  Safari read failed: ${String(err)}`)
    // Safari’s sandboxed cookie file requires Full Disk Access.
    const isPermError =
      err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EPERM'
    if (isPermError) {
      return browserCookieImportFailure('safariFullDiskAccess')
    }
    return browserCookieImportFailure('readFailed', { browser: 'Safari' })
  }

  try {
    const cookies = decodeSafariBinaryCookies(data)
    diag(`  Safari source has ${cookies.length} cookies`)

    if (cookies.length === 0) {
      return browserCookieImportFailure('noCookies', { browser: 'Safari' })
    }

    const now = Math.floor(Date.now() / 1000)
    const valid = cookies.filter((c) => !c.expirationDate || c.expirationDate > now)

    if (valid.length === 0) {
      return browserCookieImportFailure('allCookiesExpired', { browser: 'Safari' })
    }

    return importValidatedCookies(valid, cookies.length, cookieImportTarget(targetPartition))
  } catch (err) {
    diag(`  Safari import failed: ${String(err)}`)
    return browserCookieImportFailure('importFailed', { browser: 'Safari' })
  }
}
