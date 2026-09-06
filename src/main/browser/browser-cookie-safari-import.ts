import { readFileSync } from 'node:fs'
import type { BrowserCookieImportResult } from '../../shared/browser-workspace-types'
import { decodeSafariBinaryCookies } from './browser-cookie-safari-parser'
import { importValidatedCookies, cookieImportTarget } from './browser-cookie-import-pipeline'
import type { DetectedBrowser } from './browser-cookie-detection-types'
import { diag } from './browser-cookie-import-diagnostics'

// ---------------------------------------------------------------------------
// Safari import
// ---------------------------------------------------------------------------

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
    // Why: Safari's Cookies.binarycookies is in a sandbox container; reading it needs Full Disk Access.
    const isPermError =
      err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EPERM'
    if (isPermError) {
      return {
        ok: false,
        reason:
          'macOS denied access to Safari cookies. Grant Full Disk Access to Orca in System Settings → Privacy & Security → Full Disk Access.'
      }
    }
    return { ok: false, reason: 'Could not read Safari cookies.' }
  }

  try {
    const cookies = decodeSafariBinaryCookies(data)
    diag(`  Safari source has ${cookies.length} cookies`)

    if (cookies.length === 0) {
      return { ok: false, reason: 'No cookies found in Safari.' }
    }

    const now = Math.floor(Date.now() / 1000)
    const valid = cookies.filter((c) => !c.expirationDate || c.expirationDate > now)

    if (valid.length === 0) {
      return { ok: false, reason: 'All Safari cookies are expired.' }
    }

    return importValidatedCookies(
      valid,
      cookies.length,
      cookieImportTarget(targetPartition),
      'replace-imported-domains'
    )
  } catch (err) {
    diag(`  Safari import failed: ${String(err)}`)
    return { ok: false, reason: 'Could not import cookies from Safari.' }
  }
}
