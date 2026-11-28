import { retainLocalGoogleCookieClearTarget } from '../../browser/cookies/browser-google-cookie-clear-target'
import { browserCookieImportFailure } from '../../../shared/browser/cookies/browser-cookie-import-failure-copy'
import { registerGoogleCookieClearHandlers } from './browser-google-cookie-clear-ipc'
import { registerClientHostCookieImportHandlers } from './browser-client-host-cookie-import-ipc'
import { registerCookieClearHandlers } from './browser-cookie-clear-ipc'
import { BrowserWindow, ipcMain } from 'electron'
import type { IpcHandleRegistrar } from '../lazy-ipc-handle-group'
import { browserSessionRegistry } from '../../browser/sessions/profiles/browser-session-registry'
import { getPairedRuntimeBrowserClientRouteIdentity } from '../../browser/client-hosts/lifecycle/paired-runtime-browser-client-host-state'
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

export function registerBrowserSessionProfileHandlers(ipc: IpcHandleRegistrar = ipcMain): void {
  if (ipc === ipcMain) {
    for (const channel of [
      'browser:session:listProfiles',
      'browser:session:createProfile',
      'browser:session:deleteProfile',
      'browser:session:ensureManagedProfile',
      'browser:identity:get',
      'browser:identity:set',
      'browser:session:importCookies',
      'browser:session:resolvePartition',
      'browser:sitePermissions:list',
      'browser:sitePermissions:set',
      'browser:session:detectBrowsers',
      'browser:session:detectBrowsersForClientHost',
      'browser:session:importFromBrowser'
    ]) {
      ipcMain.removeHandler(channel)
    }
  }

  ipc.handle('browser:session:listProfiles', (event): BrowserSessionProfile[] => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      return []
    }
    return browserSessionRegistry.listProfiles()
  })

  ipc.handle(
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

  ipc.handle(
    'browser:session:ensureManagedProfile',
    (event, args: { owner: ManagedBrowserProfileOwner; label: string }) =>
      isTrustedBrowserRenderer(event.sender)
        ? ensureManagedBrowserProfile(args?.owner, args?.label)
        : null
  )

  ipc.handle('browser:identity:get', (event) => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      return null
    }
    return getBrowserIdentityModeStatus()
  })

  ipc.handle('browser:identity:set', async (event, mode: unknown) => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      return null
    }
    // Match RPC rejection: silently coercing future modes would report false success.
    if (mode !== 'clean' && mode !== 'native') {
      throw new Error(`Unsupported browser identity mode: ${String(mode)}`)
    }
    return setBrowserIdentityMode(mode)
  })

  ipc.handle(
    'browser:session:deleteProfile',
    async (event, args: { profileId: string }): Promise<boolean> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return false
      }
      return browserSessionRegistry.deleteProfile(args.profileId)
    }
  )

  ipc.handle(
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
          {
            sshTargetId,
            browserProfileId: args.profileId,
            targetRegistered: await isRegisteredSshTarget(sshTargetId)
          },
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
        browserSessionRegistry.updateProfileSource(args.profileId, {
          ...source.badge,
          importedAt: Date.now()
        })
        return retainLocalGoogleCookieClearTarget(result, profile, args.profileId)
      }
      return result
    }
  )

  ipc.handle(
    'browser:session:resolvePartition',
    (event, args: { profileId: string | null }): string | null => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return null
      }
      return browserSessionRegistry.resolvePartition(args.profileId)
    }
  )

  ipc.handle(
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

  ipc.handle(
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

  registerGoogleCookieClearHandlers(ipc)
  registerClientHostCookieImportHandlers(ipc)
  registerCookieClearHandlers(ipc)

  ipc.handle('browser:session:detectBrowsers', (event): DetectedBrowserPickerEntry[] => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      return []
    }
    return detectedBrowserPickerEntries()
  })

  // List browsers on the machine whose cookie store import will read.
  ipc.handle(
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

  ipc.handle(
    'browser:session:importFromBrowser',
    async (
      event,
      args: {
        profileId: string
        browserFamily: string
        browserProfile?: string
        sshTargetId?: unknown
      }
    ): Promise<BrowserCookieImportResult> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return browserCookieImportFailure('notAuthorized')
      }
      const sshTargetId = sshRouteTargetId(args)
      if (sshTargetId) {
        return importCookiesIntoSshRoutePartition({
          sshTargetId,
          browserProfileId: args.profileId,
          targetRegistered: await isRegisteredSshTarget(sshTargetId),
          browserFamily: args.browserFamily,
          browserProfile: args.browserProfile
        })
      }
      const profile = browserSessionRegistry.getProfile(args.profileId)
      if (!profile) {
        return browserCookieImportFailure('profileNotFound')
      }
      const source = browserCookieImportSource(args)
      if ('reason' in source) {
        return source
      }
      const result = await source.importInto(profile.partition)
      if (result.ok) {
        browserSessionRegistry.updateProfileSource(args.profileId, {
          ...source.badge,
          importedAt: Date.now()
        })
        return retainLocalGoogleCookieClearTarget(result, profile, args.profileId)
      }
      return result
    }
  )
}

async function isRegisteredSshTarget(targetId: string): Promise<boolean> {
  const { getSshConnectionStore } = await import('../ssh/ssh')
  return getSshConnectionStore()?.getTarget(targetId) !== undefined
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
