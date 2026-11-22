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
import { restoreBrowserRoutePartitionSessionCookies } from '../session-restore/browser-session-cookie-restore'

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
  resolveSource: () => Promise<RouteCookieImportSource | BrowserCookieImportFailure>
): Promise<
  | {
      ok: true
      result: RouteCookieImportSuccess
      partition: string
      source: RouteCookieImportSource
    }
  | BrowserCookieImportFailure
> {
  const source = await resolveSource()
  if ('reason' in source) {
    return source
  }
  let partition: string | null
  try {
    partition = destination.bindPartition()
  } catch (error) {
    return { ok: false, reason: errorMessage(error) }
  }
  if (partition === null) {
    return destination.routeChanged(null)
  }
  // Saved session cookies go back first, or the next page's restore would overwrite the import.
  await restoreBrowserRoutePartitionSessionCookies(partition)
  const result = await source.importInto(partition)
  let settled: string | null
  try {
    settled = destination.currentPartition()
  } catch {
    settled = null
  }
  if (settled !== partition) {
    return destination.routeChanged(settled)
  }
  if (!result.ok) {
    return result
  }
  return { ok: true, result, partition, source }
}

export function browserCookieImportSource(
  request: BrowserCookieImportSelection,
  previous?: BrowserSessionProfileSource | null
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
    importInto: (partition) => importCookiesFromBrowser(browser, partition),
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
