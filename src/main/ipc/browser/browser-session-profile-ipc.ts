import { retainLocalGoogleCookieClearTarget } from '../../browser/cookies/browser-google-cookie-clear-target'
import { browserCookieImportFailure } from '../../../shared/browser/cookies/browser-cookie-import-failure-copy'
import { registerGoogleCookieClearHandlers } from './browser-google-cookie-clear-ipc'
import { registerClientHostCookieImportHandlers } from './browser-client-host-cookie-import-ipc'
import { BrowserWindow, ipcMain } from 'electron'
import { browserSessionRegistry } from '../../browser/sessions/profiles/browser-session-registry'
import { getPairedRuntimeBrowserClientRouteIdentity } from '../../browser/client-hosts/lifecycle/paired-runtime-browser-client-host-runtime'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'
import { pickCookieFile } from '../../browser/cookies/imports/cookie-file-picker'
import { detectInstalledBrowsers } from '../../browser/cookies/sources/browser-cookie-detection'
import {
  browserCookieImportSource,
  cookieFileImportSource
} from '../../browser/cookies/route-partition/browser-route-partition-cookie-import'
import {
  importCookieFileIntoSshRoutePartition,
  importCookiesIntoSshRoutePartition
} from '../../browser/cookies/route-partition/browser-ssh-route-cookie-import'
import type {
  BrowserCookieImportResult,
  BrowserCookieImportSelection,
  BrowserSessionProfile,
  BrowserSessionProfileScope
} from '../../../shared/browser/workspaces/browser-workspace-types'
import type { ManagedBrowserProfileOwner } from '../../../shared/browser/profiles/browser-profile-scope'
import { ensureManagedBrowserProfile } from '../../browser/sessions/profiles/browser-managed-session-profiles'
import {
  getBrowserIdentityModeStatus,
  setBrowserIdentityMode
} from '../../browser/identity/mode/browser-identity-mode-store'
import {
  listBrowserSitePermissions,
  setBrowserSitePermissionDecisions
} from '../../browser/site-settings/permissions/browser-site-permission-store'
import {
  isBrowserSitePermissionKey,
  isValidBrowserSitePermissionDecision,
  type BrowserSitePermissionEntry
} from '../../../shared/browser/site-settings/browser-site-permission'

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
    async (
      event,
      args: { profileId: string; sshTargetId?: unknown }
    ): Promise<BrowserCookieImportResult> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return browserCookieImportFailure('notAuthorized')
      }
      const parent = BrowserWindow.fromWebContents(event.sender)
      const sshTargetId = sshRouteTargetId(args)
      if (sshTargetId) {
        return importCookieFileIntoSshRoutePartition(
          { sshTargetId, browserProfileId: args.profileId },
          () => pickCookieFile(parent)
        )
      }
      const profile = browserSessionRegistry.getProfile(args.profileId)
      if (!profile) {
        return browserCookieImportFailure('profileNotFound')
      }

      const source = await cookieFileImportSource(() => pickCookieFile(parent))
      if ('reason' in source) {
        return source
      }
      const result = await source.importInto(profile.partition)
      if (result.ok) {
        browserSessionRegistry.updateProfileSource(args.profileId, source.importedSource())
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
        !isBrowserSitePermissionKey(args.permission) ||
        (args.decision !== null &&
          !isValidBrowserSitePermissionDecision(args.permission, args.decision))
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
      args: { profileId: string; sshTargetId?: unknown } & BrowserCookieImportSelection
    ): Promise<BrowserCookieImportResult> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return browserCookieImportFailure('notAuthorized')
      }
      if (args.sshTargetId !== undefined) {
        if ('refreshSourceId' in args) {
          return browserCookieImportFailure('savedChromeProfileUnavailable')
        }
        const sshTargetId = sshRouteTargetId(args)
        if (!sshTargetId) {
          return browserCookieImportFailure('sshHostDisconnected')
        }
        return importCookiesIntoSshRoutePartition({
          sshTargetId,
          browserProfileId: args.profileId,
          browserFamily: args.browserFamily,
          browserProfile: args.browserProfile
        })
      }
      const profile = browserSessionRegistry.getProfile(args.profileId)
      if (!profile) {
        return browserCookieImportFailure('profileNotFound')
      }
      const source = browserCookieImportSource(args, profile.source)
      if ('reason' in source) {
        return source
      }
      const result = await source.importInto(profile.partition)
      if (result.ok) {
        browserSessionRegistry.updateProfileSource(args.profileId, source.importedSource())
        return retainLocalGoogleCookieClearTarget(result, profile, args.profileId)
      }
      return result
    }
  )
}

/** A page routed through an SSH host names its host, so the import lands in that host's jar. */
function sshRouteTargetId(args: { sshTargetId?: unknown }): string | null {
  return typeof args.sshTargetId === 'string' && args.sshTargetId.length > 0
    ? args.sshTargetId
    : null
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
