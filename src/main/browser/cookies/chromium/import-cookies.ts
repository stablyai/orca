import { session } from 'electron'
import { existsSync } from 'node:fs'
import type { BrowserCookieImportResult } from '../../../../shared/browser-workspace-types'
import {
  diag,
  reasonWithDiagLog,
  summarizeCookieImportError
} from '../browser-cookie-import-diagnostics'
import type { DetectedBrowser } from '../sources/browser-cookie-detection-types'
import type { CookieImportOptions } from '../browser-cookie-import-pipeline'
import { withCookieMutationLock } from '../browser-cookie-import-clear'
import { prepareChromiumCookieImport } from './prepare-import'
import { scanChromiumCookieRows } from './scan-source-rows'
import { finalizeChromiumCookieImport } from './finalize-import'
import type { ChromiumImportContext } from './import-context'

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

  const targetSession = session.fromPartition(targetPartition)
  // Admit preparation with its writes so queued imports retain no decoded source or snapshot.
  const result = await withCookieMutationLock(
    targetSession,
    async (): Promise<BrowserCookieImportResult> => {
      let context: ChromiumImportContext | null = null
      try {
        const preparation = await prepareChromiumCookieImport(browser, options, targetSession)
        if ('result' in preparation) {
          return preparation.result
        }
        context = preparation.context
        const scanResult = scanChromiumCookieRows(context)
        if (scanResult) {
          return scanResult
        }
        return await finalizeChromiumCookieImport(context, targetPartition)
      } catch (err) {
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
    }
  )
  if (result.ok && result.summary.importedCookies > 0) {
    try {
      await targetSession.cookies.flushStore()
    } catch (error) {
      diag(`  cookie flush failed: ${String(error)}`)
    }
  }
  return result
}
