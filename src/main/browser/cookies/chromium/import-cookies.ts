import { session } from 'electron'
import { browserCookieImportFailure } from '../../../../shared/browser-cookie-import-failure-copy'
import { existsSync } from 'node:fs'
import type { BrowserCookieImportResult } from '../../../../shared/browser-workspace-types'
import {
  diag,
  getDiagLogPath,
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
    return browserCookieImportFailure('databaseNotFound', { browser: browser.label })
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
        return browserCookieImportFailure(
          'importFailedWithLog',
          { browser: browser.label, logPath: getDiagLogPath() },
          summarizeCookieImportError(err)
        )
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
