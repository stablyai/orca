import type { BrowserWindow } from 'electron'
import type { BrowserCookieImportResult } from '../../shared/browser-workspace-types'
import {
  detectInstalledBrowsers as detectBrowsers,
  selectBrowserProfile as selectProfile
} from './browser-cookie-detection'
import type { BrowserProfile, DetectedBrowser } from './browser-cookie-detection-types'
import {
  pickCookieFile as pickFile,
  importCookiesFromFile as importFile,
  type CookieImportOptions
} from './browser-cookie-import-pipeline'
import { importChromiumCookies } from './browser-cookie-chromium-import'
import { importCookiesFromFirefox } from './browser-cookie-firefox-import'
import { importCookiesFromSafari } from './browser-cookie-safari-import'
import {
  buildChromiumCookieInsertParams as buildInsertParams,
  type ChromiumCookieColumnInfo
} from './browser-cookie-sqlite'
import { isAppBoundEncryptedCookie as isAppBoundCookie } from './browser-cookie-decryption'
import { summarizeCookieImportError as summarizeError } from './browser-cookie-import-diagnostics'

export type { BrowserProfile, DetectedBrowser, CookieImportOptions, ChromiumCookieColumnInfo }
export { summarizeError as summarizeCookieImportError }

export function detectInstalledBrowsers(): DetectedBrowser[] {
  return detectBrowsers()
}

export function selectBrowserProfile(
  browser: DetectedBrowser,
  profileDirectory: string
): DetectedBrowser | null {
  return selectProfile(browser, profileDirectory)
}

export async function pickCookieFile(parentWindow: BrowserWindow | null): Promise<string | null> {
  return pickFile(parentWindow)
}

export async function importCookiesFromFile(
  filePath: string,
  targetPartition: string
): Promise<BrowserCookieImportResult> {
  return importFile(filePath, targetPartition)
}

export function buildChromiumCookieInsertParams(
  targetColumns: ChromiumCookieColumnInfo[],
  sourceRow: Record<string, unknown>,
  decryptedValue: Buffer
): (string | number | bigint | Buffer | null)[] {
  return buildInsertParams(targetColumns, sourceRow, decryptedValue)
}

export function isAppBoundEncryptedCookie(encryptedBuffer: Buffer): boolean {
  return isAppBoundCookie(encryptedBuffer)
}

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
