import type { BrowserCookieImportResult } from '../../../shared/browser-workspace-types'
import type { DetectedBrowser } from './sources/browser-cookie-source-profiles'
import type { CookieImportOptions } from './imports/cookie-import-contracts'
import { importChromiumCookies } from './chromium/import-cookies'
import { importCookiesFromFirefox } from './sources/browser-cookie-firefox-import'
import { importCookiesFromSafari } from './sources/browser-cookie-safari-import'

export async function importCookiesFromBrowser(
  browser: DetectedBrowser,
  targetPartition: string,
  options: CookieImportOptions = {}
): Promise<BrowserCookieImportResult> {
  if (browser.family === 'firefox') {
    return importCookiesFromFirefox(browser, targetPartition, options)
  }
  if (browser.family === 'safari') {
    return importCookiesFromSafari(browser, targetPartition)
  }
  return importChromiumCookies(browser, targetPartition, options)
}
