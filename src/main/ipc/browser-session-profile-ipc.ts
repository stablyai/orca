import { BrowserWindow, ipcMain } from 'electron'
import { browserSessionRegistry } from '../browser/browser-session-registry'
import { importCookiesIntoClientRoutePartition } from '../browser/browser-client-route-cookie-import'
import { clientRouteCookieImportSources } from '../browser/client-route-cookie-import-source-store'
import { getPairedRuntimeBrowserClientRouteIdentity } from '../browser/paired-runtime-browser-client-host-runtime'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'
import {
  pickCookieFile,
  importCookiesFromFile,
  detectInstalledBrowsers,
  selectBrowserProfile,
  importCookiesFromBrowser
} from '../browser/browser-cookie-import'
import type {
  BrowserCookieImportResult,
  BrowserSessionProfile,
  BrowserSessionProfileCreateOptions,
  BrowserSessionProfileScope
} from '../../shared/browser-workspace-types'

export function registerBrowserSessionProfileHandlers(): void {
  ipcMain.removeHandler('browser:session:listProfiles')
  ipcMain.removeHandler('browser:session:createProfile')
  ipcMain.removeHandler('browser:session:deleteProfile')
  ipcMain.removeHandler('browser:session:importCookies')
  ipcMain.removeHandler('browser:session:resolvePartition')

  ipcMain.handle('browser:session:listProfiles', (event): BrowserSessionProfile[] => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      return []
    }
    return browserSessionRegistry.listProfiles()
  })

  ipcMain.handle(
    'browser:session:createProfile',
    async (
      event,
      args: {
        scope: BrowserSessionProfileScope
        label: string
      } & BrowserSessionProfileCreateOptions
    ): Promise<BrowserSessionProfile | null> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return null
      }
      return await browserSessionRegistry.createProfile(args.scope, args.label, {
        userAgentMode: args.userAgentMode
      })
    }
  )

  ipcMain.handle(
    'browser:session:deleteProfile',
    async (event, args: { profileId: string }): Promise<boolean> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return false
      }
      return browserSessionRegistry.deleteProfile(args.profileId)
    }
  )

  ipcMain.handle(
    'browser:session:importCookies',
    async (event, args: { profileId: string }): Promise<BrowserCookieImportResult> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return { ok: false, reason: 'Not authorized' }
      }
      const profile = browserSessionRegistry.getProfile(args.profileId)
      if (!profile) {
        return { ok: false, reason: 'Session profile not found.' }
      }

      const parent = BrowserWindow.fromWebContents(event.sender)
      const filePath = await pickCookieFile(parent)
      if (!filePath) {
        return { ok: false, reason: 'canceled' }
      }

      const result = await importCookiesFromFile(filePath, profile.partition)
      if (result.ok) {
        browserSessionRegistry.updateProfileSource(args.profileId, {
          browserFamily: 'manual',
          importedAt: Date.now()
        })
        return { ...result, profileId: args.profileId }
      }
      return result
    }
  )

  ipcMain.handle(
    'browser:session:resolvePartition',
    (event, args: { profileId: string | null }): string | null => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return null
      }
      return browserSessionRegistry.resolvePartition(args.profileId)
    }
  )

  ipcMain.removeHandler('browser:session:clearDefaultCookies')

  ipcMain.handle('browser:session:clearDefaultCookies', async (event): Promise<boolean> => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      return false
    }
    return browserSessionRegistry.clearDefaultSessionCookies()
  })

  ipcMain.removeHandler('browser:session:detectBrowsers')
  ipcMain.removeHandler('browser:session:detectBrowsersForClientHost')
  ipcMain.removeHandler('browser:session:importFromBrowser')
  ipcMain.removeHandler('browser:session:importFromBrowserForClientHost')

  // Why: client-hosted pages render on this desktop, so their logins must be
  // detected and imported here -- the remote runtime is usually headless.
  ipcMain.handle(
    'browser:session:importFromBrowserForClientHost',
    async (
      event,
      args: {
        environmentId: string
        profileId: string
        browserFamily: string
        browserProfile?: string
      }
    ): Promise<BrowserCookieImportResult | null> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return { ok: false, reason: 'Not authorized' }
      }
      return importCookiesIntoClientRoutePartition({
        environmentId: args.environmentId,
        browserProfileId: args.profileId,
        browserFamily: args.browserFamily,
        browserProfile: args.browserProfile
      })
    }
  )

  ipcMain.removeHandler('browser:session:clientRouteImportSources')

  // Why: the server's profile records can't know what this desktop imported into
  // its client-hosted jars; the settings view overlays these onto the RPC list.
  ipcMain.handle(
    'browser:session:clientRouteImportSources',
    (event, args: { environmentId: string }) => {
      if (!isTrustedBrowserRenderer(event.sender) || typeof args?.environmentId !== 'string') {
        return {}
      }
      return clientRouteCookieImportSources(args.environmentId)
    }
  )

  ipcMain.handle('browser:session:detectBrowsers', (event): DetectedBrowserPickerEntry[] => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      return []
    }
    return detectedBrowserPickerEntries()
  })

  // Why: the picker must list the machine the import will actually read from, and for a
  // client-hosted environment that is this desktop — never the (usually headless) remote.
  ipcMain.handle(
    'browser:session:detectBrowsersForClientHost',
    (event, args: { environmentId: string }): DetectedBrowserPickerEntry[] | null => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return []
      }
      if (!getPairedRuntimeBrowserClientRouteIdentity(args.environmentId)) {
        return null
      }
      return detectedBrowserPickerEntries()
    }
  )

  ipcMain.handle(
    'browser:session:importFromBrowser',
    async (
      event,
      args: { profileId: string; browserFamily: string; browserProfile?: string }
    ): Promise<BrowserCookieImportResult> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return { ok: false, reason: 'Not authorized' }
      }
      const profile = browserSessionRegistry.getProfile(args.profileId)
      if (!profile) {
        return { ok: false, reason: 'Session profile not found.' }
      }

      // Why: browserProfile comes from the renderer and is used to construct
      // a filesystem path. Reject traversal characters to prevent a compromised
      // renderer from reading arbitrary files via the cookie import pipeline.
      if (
        args.browserProfile &&
        (/[/\\]/.test(args.browserProfile) || args.browserProfile.includes('..'))
      ) {
        return { ok: false, reason: 'Invalid browser profile name.' }
      }

      const browsers = detectInstalledBrowsers()
      let browser = browsers.find((b) => b.family === args.browserFamily)
      if (!browser) {
        return { ok: false, reason: 'Browser not found on this system.' }
      }

      // Why: if the user selected a non-default profile from the picker,
      // resolve the cookies path for that specific profile.
      if (args.browserProfile && args.browserProfile !== browser.selectedProfile) {
        const reselected = selectBrowserProfile(browser, args.browserProfile)
        if (!reselected) {
          return {
            ok: false,
            reason: `No cookies database found for profile "${args.browserProfile}".`
          }
        }
        browser = reselected
      }

      const result = await importCookiesFromBrowser(browser, profile.partition)
      if (result.ok) {
        const profileName =
          browser.profiles.find((p) => p.directory === browser.selectedProfile)?.name ??
          browser.selectedProfile
        browserSessionRegistry.updateProfileSource(args.profileId, {
          browserFamily: browser.family,
          profileName,
          importedAt: Date.now()
        })
        return { ...result, profileId: args.profileId }
      }
      return result
    }
  )
}

type DetectedBrowserPickerEntry = {
  family: string
  label: string
  profiles: { name: string; directory: string }[]
  selectedProfile: string
}

// Why: the renderer only needs family/label/profiles for the UI picker. Strip cookiesPath,
// keychainService, and keychainAccount to avoid exposing filesystem paths and credential store
// identifiers to the renderer.
function detectedBrowserPickerEntries(): DetectedBrowserPickerEntry[] {
  return detectInstalledBrowsers().map((browser) => ({
    family: browser.family,
    label: browser.label,
    profiles: browser.profiles,
    selectedProfile: browser.selectedProfile
  }))
}
