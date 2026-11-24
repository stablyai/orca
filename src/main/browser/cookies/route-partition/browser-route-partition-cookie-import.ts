import { session } from 'electron'
import type {
  BrowserCookieImportResult,
  BrowserCookieImportSelection,
  BrowserSessionProfileSource
} from '../../../../shared/browser/workspaces/browser-workspace-types'
import type { BrowserCookieImportFailure } from '../../../../shared/browser/cookies/browser-cookie-import-failure-copy'
import {
  detectInstalledBrowsers,
  resolveBrowserImportSelection,
  selectBrowserProfile
} from '../sources/browser-cookie-detection'
import { importCookiesFromBrowser } from '../browser-cookie-import'
import { importCookiesFromFile } from '../imports/import-cookie-file'
import { importedBrowserProfileSource } from '../sources/browser-cookie-source-profiles'
import { errorMessage } from '../../../../shared/errors/error-message'
import { restoreBrowserRoutePartitionSessionCookies } from '../session-restore/browser-session-cookie-route-restore'
import { withCookieImportSourceLock } from '../mutation/cookie-mutation-lock'
import type { CookieImportOptions } from '../imports/cookie-import-contracts'

export type RouteCookieImportSource = {
  importInto: (partition: string) => Promise<BrowserCookieImportResult>
  importedSource: () => BrowserSessionProfileSource
}

type RouteCookieImportSuccess = Extract<BrowserCookieImportResult, { ok: true }>

/**
 * Route partitions (SSH and This-device pages) are the page's own jar, not the profile's.
 * `bindPartition` names the jar the request was made for (null when the route is gone, throws
 * when it can't take cookies); `currentPartition` names it after the import, so a route that
 * moved meanwhile fails instead of reporting another jar's success.
 */
export async function importIntoRoutePartition(
  destination: {
    bindPartition: () => string | null
    currentPartition: () => string | null
    routeChanged: (settled: string | null) => BrowserCookieImportFailure
  },
  resolveSource: () => Promise<RouteCookieImportSource | BrowserCookieImportFailure>,
  recordSource?: (partition: string, source: BrowserSessionProfileSource) => Promise<void>
): Promise<
  | {
      ok: true
      result: RouteCookieImportSuccess
      partition: string
    }
  | BrowserCookieImportFailure
> {
  let partition: string | null
  try {
    partition = destination.bindPartition()
  } catch (error) {
    return { ok: false, reason: errorMessage(error) }
  }
  if (partition === null) {
    return destination.routeChanged(null)
  }
  const jar = partition
  const currentPartition = (): string | null => {
    try {
      return destination.currentPartition()
    } catch {
      return null
    }
  }
  return withCookieImportSourceLock(session.fromPartition(jar), async () => {
    const beforeRestore = currentPartition()
    if (beforeRestore !== jar) {
      return destination.routeChanged(beforeRestore)
    }
    // Saved session cookies go back first, or the next page's restore would overwrite the import.
    await restoreBrowserRoutePartitionSessionCookies(jar)
    const source = await resolveSource()
    if ('reason' in source) {
      return source
    }
    const settled = currentPartition()
    if (settled !== jar) {
      return destination.routeChanged(settled)
    }
    const result = await source.importInto(jar)
    const afterImport = currentPartition()
    if (afterImport !== jar) {
      return destination.routeChanged(afterImport)
    }
    if (!result.ok) {
      return result
    }
    if (recordSource && result.summary.importedCookies > 0) {
      await recordSource(jar, source.importedSource())
    }
    return { ok: true, result, partition: jar }
  })
}

export function browserCookieImportSource(
  request: BrowserCookieImportSelection,
  previous?: BrowserSessionProfileSource | null,
  options?: CookieImportOptions
): RouteCookieImportSource | BrowserCookieImportFailure {
  const selection = resolveBrowserImportSelection(request, previous)
  if ('reason' in selection) {
    return selection
  }
  const [detected] = detectInstalledBrowsers(selection.browserFamily)
  const browser = selectBrowserProfile(detected, selection)
  if ('reason' in browser) {
    return browser
  }
  return {
    importInto: (partition) => importCookiesFromBrowser(browser, partition, options),
    importedSource: () => importedBrowserProfileSource(browser)
  }
}

export async function cookieFileImportSource(
  pickFile: () => Promise<string | null>
): Promise<RouteCookieImportSource | BrowserCookieImportFailure> {
  const filePath = await pickFile()
  if (!filePath) {
    return { ok: false, reason: 'canceled' }
  }
  return {
    importInto: (partition) => importCookiesFromFile(filePath, partition),
    importedSource: () => ({ browserFamily: 'manual', importedAt: Date.now() })
  }
}
