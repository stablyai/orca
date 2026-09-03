// @ts-nocheck -- mechanically split class members.
import { RuntimeBrowserCommandsWithBrowserTabSetProfile } from './runtime-browser-commands-browser-tab-set-profile'
import type {
  BrowserProfileClearDefaultCookiesResult,
  BrowserProfileImportFromBrowserResult
} from '../../shared/runtime-types'
import { browserSessionRegistry } from '../browser/browser-session-registry'
import {
  detectAllBrowsers,
  importCookiesFromBrowser,
  selectBrowserProfile
} from '../browser/browser-cookie-import'

export class RuntimeBrowserCommandsWithBrowserProfileImportFromBrowser extends RuntimeBrowserCommandsWithBrowserTabSetProfile {
  async browserProfileImportFromBrowser(params: {
    profileId: string
    browserFamily: string
    browserProfile?: string
    customBrowserId?: string
    supportsPartitionSkippedCookies?: true
  }): Promise<BrowserProfileImportFromBrowserResult> {
    const profile = browserSessionRegistry.getProfile(params.profileId)
    if (!profile) {
      return { ok: false, reason: 'Session profile not found.' }
    }
    if (
      params.browserProfile &&
      (/[/\\]/.test(params.browserProfile) || params.browserProfile.includes('..'))
    ) {
      return { ok: false, reason: 'Invalid browser profile name.' }
    }

    const browsers = await detectAllBrowsers()
    // Why: custom browsers all share family 'custom', so a customBrowserId request must
    // match on that id; without one, refuse an ambiguous family match rather than importing
    // the wrong browser. Older clients that omit it still work when exactly one matches.
    const matches = params.customBrowserId
      ? browsers.filter((candidate) => candidate.customBrowserId === params.customBrowserId)
      : browsers.filter((candidate) => candidate.family === params.browserFamily)
    if (!params.customBrowserId && params.browserFamily === 'custom' && matches.length > 1) {
      return {
        ok: false,
        reason: 'Multiple custom browsers detected; customBrowserId is required.'
      }
    }
    let browser = matches[0]
    if (!browser) {
      return { ok: false, reason: 'Browser not found on this system.' }
    }

    if (params.browserProfile && params.browserProfile !== browser.selectedProfile) {
      const reselected = selectBrowserProfile(browser, params.browserProfile)
      if (!reselected) {
        return {
          ok: false,
          reason: `No cookies database found for profile "${params.browserProfile}".`
        }
      }
      browser = reselected
    }

    const result = await importCookiesFromBrowser(browser, profile.partition, {
      canReportPartitionSkippedCookies: params.supportsPartitionSkippedCookies === true
    })
    if (!result.ok) {
      return result
    }

    const profileName =
      browser.profiles.find((candidate) => candidate.directory === browser.selectedProfile)?.name ??
      browser.selectedProfile
    browserSessionRegistry.updateProfileSource(params.profileId, {
      browserFamily: browser.family,
      // Why: custom browsers share family 'custom'; persist their real name so
      // Settings distinguishes them (browserSourceLabel prefers sourceLabel).
      ...(browser.family === 'custom' ? { sourceLabel: browser.label } : {}),
      profileName,
      importedAt: Date.now()
    })
    return { ...result, profileId: params.profileId }
  }

  async browserProfileClearDefaultCookies(): Promise<BrowserProfileClearDefaultCookiesResult> {
    return { cleared: await browserSessionRegistry.clearDefaultSessionCookies() }
  }
}
