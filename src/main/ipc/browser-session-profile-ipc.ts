import { retainLocalGoogleCookieClearTarget } from '../browser/browser-google-cookie-clear-target'
import { browserCookieImportFailure } from '../../shared/browser-cookie-import-failure-copy'
import { registerGoogleCookieClearHandlers } from './browser-google-cookie-clear-ipc'
import { registerClientHostCookieImportHandlers } from './browser-client-host-cookie-import-ipc'
import { BrowserWindow, ipcMain } from 'electron'
import { browserSessionRegistry } from '../browser/browser-session-registry'
import { getPairedRuntimeBrowserClientRouteIdentity } from '../browser/paired-runtime-browser-client-host-runtime'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'
import {
  pickCookieFile,
  importCookiesFromFile,
  detectInstalledBrowsers,
  selectBrowserProfile,
  importCookiesFromBrowser
} from '../browser/cookies/browser-cookie-import'
import type {
  BrowserCookieImportResult,
  BrowserSessionProfile,
  BrowserSessionProfileScope
} from '../../shared/browser-workspace-types'
import type { ManagedBrowserProfileOwner } from '../../shared/browser-profile-scope'
import { ensureManagedBrowserProfile } from '../browser/browser-managed-session-profiles'
import {
  getBrowserIdentityModeStatus,
  setBrowserIdentityMode
} from '../browser/browser-identity-mode-store'
import {
  listBrowserSitePermissions,
  setBrowserSitePermissionDecisions
} from '../browser/browser-site-permission-store'
import {
  isBrowserSitePermission,
  isBrowserSitePermissionDecision,
  type BrowserSitePermissionEntry
} from '../../shared/browser-site-permission'

export function registerBrowserSessionProfileHandlers(): void {
  ipcMain.removeHandler('browser:session:listProfiles')
  ipcMain.removeHandler('browser:session:createProfile')
  ipcMain.removeHandler('browser:session:deleteProfile')
  ipcMain.removeHandler('browser:session:ensureManagedProfile')
  ipcMain.removeHandler('browser:identity:get')
  ipcMain.removeHandler('browser:identity:set')
  ipcMain.removeHandler('browser:session:importCookies')
  ipcMain.removeHandler('browser:session:resolvePartition')
  ipcMain.removeHandler('browser:sitePermissions:list')
  ipcMain.removeHandler('browser:sitePermissions:set')

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
      args: { scope: BrowserSessionProfileScope; label: string }
    ): Promise<BrowserSessionProfile | null> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return null
      }
      return await browserSessionRegistry.createProfile(args.scope, args.label)
    }
  )

  ipcMain.handle(
    'browser:session:ensureManagedProfile',
    (event, args: { owner: ManagedBrowserProfileOwner; label: string }) =>
      isTrustedBrowserRenderer(event.sender)
        ? ensureManagedBrowserProfile(args?.owner, args?.label)
        : null
  )

  ipcMain.handle('browser:identity:get', (event) => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      return null
    }
    return getBrowserIdentityModeStatus()
  })

  ipcMain.handle('browser:identity:set', async (event, mode: unknown) => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      return null
    }
    // Match RPC rejection: silently coercing future modes would report false success.
    if (mode !== 'clean' && mode !== 'native') {
      throw new Error(`Unsupported browser identity mode: ${String(mode)}`)
    }
    return setBrowserIdentityMode(mode)
  })

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
        return browserCookieImportFailure('notAuthorized')
      }
      const profile = browserSessionRegistry.getProfile(args.profileId)
      if (!profile) {
        return browserCookieImportFailure('profileNotFound')
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
        return retainLocalGoogleCookieClearTarget(result, profile, args.profileId)
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

  ipcMain.handle(
    'browser:sitePermissions:list',
    (event, args: { profileId: string }): BrowserSitePermissionEntry[] => {
      if (
        !isTrustedBrowserRenderer(event.sender) ||
        !browserSessionRegistry.getProfile(args.profileId)
      ) {
        return []
      }
      return listBrowserSitePermissions(args.profileId)
    }
  )

  ipcMain.handle(
    'browser:sitePermissions:set',
    (
      event,
      args: { profileId: string; origin: string; permission: unknown; decision: unknown }
    ): BrowserSitePermissionEntry[] => {
      if (
        !isTrustedBrowserRenderer(event.sender) ||
        !browserSessionRegistry.getProfile(args.profileId)
      ) {
        return []
      }
      if (
        !isBrowserSitePermission(args.permission) ||
        (args.decision !== null && !isBrowserSitePermissionDecision(args.decision))
      ) {
        throw new Error('Unsupported site permission change')
      }
      setBrowserSitePermissionDecisions(
        args.profileId,
        args.origin,
        [args.permission],
        args.decision
      )
      return listBrowserSitePermissions(args.profileId)
    }
  )

  registerGoogleCookieClearHandlers()
  registerClientHostCookieImportHandlers()

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

  ipcMain.handle('browser:session:detectBrowsers', (event): DetectedBrowserPickerEntry[] => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      return []
    }
    return detectedBrowserPickerEntries()
  })

  // List browsers on the machine whose cookie store import will read.
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
        return browserCookieImportFailure('notAuthorized')
      }
      const profile = browserSessionRegistry.getProfile(args.profileId)
      if (!profile) {
        return browserCookieImportFailure('profileNotFound')
      }

      // Renderer profile names become paths; reject traversal before cookie import.
      if (
        args.browserProfile &&
        (/[/\\]/.test(args.browserProfile) || args.browserProfile.includes('..'))
      ) {
        return browserCookieImportFailure('invalidBrowserProfile')
      }

      const browsers = detectInstalledBrowsers()
      let browser = browsers.find((b) => b.family === args.browserFamily)
      if (!browser) {
        return browserCookieImportFailure('browserNotFound')
      }

      if (args.browserProfile && args.browserProfile !== browser.selectedProfile) {
        const reselected = selectBrowserProfile(browser, args.browserProfile)
        if (!reselected) {
          return browserCookieImportFailure('browserProfileDatabaseMissing', {
            profile: args.browserProfile
          })
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
        return retainLocalGoogleCookieClearTarget(result, profile, args.profileId)
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

// Return picker metadata only; keep cookie paths and keychain identifiers in main.
function detectedBrowserPickerEntries(): DetectedBrowserPickerEntry[] {
  return detectInstalledBrowsers().map((browser) => ({
    family: browser.family,
    label: browser.label,
    profiles: browser.profiles,
    selectedProfile: browser.selectedProfile
  }))
}
