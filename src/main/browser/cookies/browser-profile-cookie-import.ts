import { browserCookieImportFailure } from '../../../shared/browser-cookie-import-failure-copy'
import type { BrowserCookieReimportSettings } from '../../../shared/browser/cookies/browser-cookie-reimport-settings'
import { withTimeout } from '../../../shared/promise-timeout-fallback'
import type {
  BrowserCookieImportResult,
  BrowserSessionProfile,
  BrowserSessionProfileSource
} from '../../../shared/browser-workspace-types'
import { browserSessionRegistry } from '../sessions/profiles/browser-session-registry'
import { importCookiesFromBrowser } from './browser-cookie-import'
import { diag } from './browser-cookie-import-diagnostics'
import type { CookieImportOptions } from './imports/cookie-import-contracts'
import { detectInstalledBrowsers, selectBrowserProfile } from './sources/browser-cookie-detection'

export async function importBrowserCookiesIntoProfile(
  profile: BrowserSessionProfile,
  browserFamily: string,
  browserProfile: string | undefined,
  options: CookieImportOptions = {}
): Promise<BrowserCookieImportResult> {
  // Renderer profile names become paths; reject traversal before cookie import.
  if (browserProfile && (/[/\\]/.test(browserProfile) || browserProfile.includes('..'))) {
    return browserCookieImportFailure('invalidBrowserProfile')
  }

  const detected = detectInstalledBrowsers().find((b) => b.family === browserFamily)
  if (!detected) {
    return browserCookieImportFailure('browserNotFound')
  }
  let browser = detected
  if (browserProfile && browserProfile !== detected.selectedProfile) {
    const reselected = selectBrowserProfile(detected, browserProfile)
    if (!reselected) {
      return browserCookieImportFailure('browserProfileDatabaseMissing', {
        profile: browserProfile
      })
    }
    browser = reselected
  }

  const result = await importCookiesFromBrowser(browser, profile.partition, options)
  if (result.ok) {
    browserSessionRegistry.updateProfileSource(profile.id, {
      browserFamily: browser.family,
      profileName:
        browser.profiles.find((p) => p.directory === browser.selectedProfile)?.name ??
        browser.selectedProfile,
      profileDirectory: browser.selectedProfile,
      importedAt: Date.now()
    })
  }
  return result
}

/** Electron keeps session cookies only in memory, so imported sign-ins end when Orca quits. */
export async function reimportBrowserCookiesOnLaunch(
  settings: BrowserCookieReimportSettings
): Promise<void> {
  if (settings.browserCookieReimportOnLaunch !== true) {
    return
  }
  const reimport = reimportBrowserCookiesFromSources().catch((error) =>
    console.warn('[browser-cookies] Launch re-import failed:', error)
  )
  // Why bounded: restored tabs should load signed in, but a keychain prompt never blocks launch.
  await withTimeout(reimport, 3_000, undefined)
}

async function reimportBrowserCookiesFromSources(): Promise<void> {
  for (const profile of browserSessionRegistry.listProfiles()) {
    const source = profile.source
    if (!source || source.browserFamily === 'manual') {
      continue
    }
    const directory = source.profileDirectory ?? legacySourceProfileDirectory(source)
    if (!directory) {
      diag(`launch re-import skipped: profile=${profile.id} has no unique source browser profile`)
      continue
    }
    const result = await importBrowserCookiesIntoProfile(profile, source.browserFamily, directory)
    if (!result.ok) {
      diag(`launch re-import failed: profile=${profile.id} reason=${result.reason}`)
    }
  }
}

// Sources saved before profileDirectory existed recorded only the display name.
function legacySourceProfileDirectory(source: BrowserSessionProfileSource): string | null {
  const matches =
    detectInstalledBrowsers()
      .find((b) => b.family === source.browserFamily)
      ?.profiles.filter((p) => p.name === source.profileName) ?? []
  return matches.length === 1 ? matches[0].directory : null
}
