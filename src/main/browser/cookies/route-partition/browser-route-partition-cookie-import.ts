import type {
  BrowserCookieImportResult,
  BrowserSessionProfileSource
} from '../../../../shared/browser/workspaces/browser-workspace-types'
import {
  browserCookieImportFailure,
  type BrowserCookieImportFailure
} from '../../../../shared/browser/cookies/browser-cookie-import-failure-copy'
import { detectInstalledBrowsers, selectBrowserProfile } from '../sources/browser-cookie-detection'
import type { DetectedBrowser } from '../sources/browser-cookie-source-profiles'
import { errorMessage } from '../../../../shared/errors/error-message'

export type RouteCookieImportSource = {
  importInto: (partition: string) => Promise<BrowserCookieImportResult>
  badge: Omit<BrowserSessionProfileSource, 'importedAt'>
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
  const { restoreBrowserRoutePartitionSessionCookies } =
    await import('../session-restore/browser-session-cookie-route-restore')
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

export function browserCookieImportSource(request: {
  browserFamily: string
  browserProfile?: string
}): RouteCookieImportSource | BrowserCookieImportFailure {
  // Profile names become filesystem path segments.
  if (
    request.browserProfile &&
    (/[/\\]/.test(request.browserProfile) || request.browserProfile.includes('..'))
  ) {
    return browserCookieImportFailure('invalidBrowserProfile')
  }
  const detected = detectInstalledBrowsers().find((entry) => entry.family === request.browserFamily)
  if (!detected) {
    return browserCookieImportFailure('browserNotFound')
  }
  let browser: DetectedBrowser = detected
  if (request.browserProfile && request.browserProfile !== detected.selectedProfile) {
    const reselected = selectBrowserProfile(detected, request.browserProfile)
    if (!reselected) {
      return browserCookieImportFailure('browserProfileDatabaseMissing', {
        profile: request.browserProfile
      })
    }
    browser = reselected
  }
  return {
    importInto: async (partition) =>
      (await import('../browser-cookie-import')).importCookiesFromBrowser(browser, partition),
    badge: {
      browserFamily: browser.family,
      profileName:
        browser.profiles.find((entry) => entry.directory === browser.selectedProfile)?.name ??
        browser.selectedProfile
    }
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
    importInto: async (partition) =>
      (await import('../imports/import-cookie-file')).importCookiesFromFile(filePath, partition),
    badge: { browserFamily: 'manual' }
  }
}
