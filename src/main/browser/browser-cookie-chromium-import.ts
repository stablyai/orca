import { session } from 'electron'
import { existsSync } from 'node:fs'
import type { BrowserCookieImportResult } from '../../shared/browser-workspace-types'
import { withCookieMutationLock } from './browser-cookie-import-clear'
import {
  diag,
  reasonWithDiagLog,
  summarizeCookieImportError
} from './browser-cookie-import-diagnostics'
import type { DetectedBrowser } from './browser-cookie-detection-types'
import type { CookieImportOptions } from './browser-cookie-import-pipeline'
import { prepareChromiumCookieImport } from './browser-cookie-chromium-prepare'
import { scanChromiumCookieRows } from './browser-cookie-chromium-scan'
import { finalizeChromiumCookieImport } from './browser-cookie-chromium-finalize'
import type { ChromiumImportContext } from './browser-cookie-chromium-types'

export async function importChromiumCookies(
  browser: DetectedBrowser,
  targetPartition: string,
  options: CookieImportOptions = {}
): Promise<BrowserCookieImportResult> {
  diag(`importCookiesFromBrowser: browser=${browser.family} partition="${targetPartition}"`)
  if (!existsSync(browser.cookiesPath)) {
    diag(`  cookies DB not found: ${browser.cookiesPath}`)
    return { ok: false, reason: `${browser.label} cookies database not found.` }
  }

  // Why: cookies.set() rejects many valid values (bytes > 0x7F); instead write plaintext to the `value` column, which CookieMonster reads raw when `encrypted_value` is empty and re-encrypts on flush in packaged builds.

  // Why: CookieMonster can reject otherwise valid imported bytes, so stage a populated copy whose
  // imported-domain rows can be merged into the live DB on the next cold start.
  const targetSession = session.fromPartition(targetPartition)
  // Why (STA-4601): native imports mutate the live jar and their staged image before the old
  // clear/write lock was reached. Hold the per-partition lock from the first flush through staging,
  // live replacement, pending-image bookkeeping, and cleanup so an older image cannot race a newer
  // import on the same partition.
  return withCookieMutationLock(targetSession, async () => {
    let context: ChromiumImportContext | null = null
    try {
      const preparation = await prepareChromiumCookieImport(
        browser,
        targetPartition,
        options,
        targetSession
      )
      if ('result' in preparation) {
        return preparation.result
      }
      context = preparation.context
      const scanResult = scanChromiumCookieRows(context)
      if (scanResult) {
        return scanResult
      }
      return await finalizeChromiumCookieImport(context)
    } catch (err) {
      if (context) {
        try {
          context.sourceDb?.close()
        } catch {
          /* may already be closed */
        }
        context.closeStagingDb()
        // Why: drop the staging DB so a stale staged import isn't applied on the next cold start.
        context.discardStagingFile()
      }
      diag(`  SQLite import failed: ${String(err)}`)
      return {
        ok: false,
        reason: reasonWithDiagLog(
          `Could not import cookies from ${browser.label}: ${summarizeCookieImportError(err)}.`
        )
      }
    } finally {
      if (context) {
        try {
          context.sourceSnapshot.cleanup()
        } catch (err) {
          diag(`  Chromium snapshot cleanup failed: ${String(err)}`)
        }
      }
    }
  })
}
