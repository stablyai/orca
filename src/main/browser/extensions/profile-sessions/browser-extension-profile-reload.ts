import type { InstalledBrowserExtension } from '../../../../shared/browser/extensions/browser-extension-types'
import { browserSessionRegistry } from '../../sessions/profiles/browser-session-registry'
import { prepareBrowserExtensionDirectory } from '../installation/browser-extension-load-directory'
import {
  noteBrowserExtensionReloadedWhileIdle,
  noteBrowserExtensionReloadPendingInIdleProfile
} from './browser-extension-idle-kept-state'
import { recordBrowserExtensionLoadFailure } from './browser-extension-load-errors'
import { getBrowserExtensionDnrStore } from '../declarative-net-request/session/browser-extension-dnr-store'
import {
  getBrowserExtensionSessionForProfile,
  loadBrowserExtensionIntoProfile,
  unloadBrowserExtensionFromProfile
} from './browser-extension-session-loader'
import { listBrowserExtensionRouteProfileIds } from './browser-extension-route-profiles'

function isEnabledIn(profileId: string, extensionId: string): boolean {
  return browserSessionRegistry.getEnabledExtensionIds(profileId).includes(extensionId)
}

/** Why attached too: a profile that went idle meanwhile loads the new copy when it reopens. */
function stillLoadsIn(profileId: string, extensionId: string): boolean {
  return (
    isEnabledIn(profileId, extensionId) && getBrowserExtensionSessionForProfile(profileId) !== null
  )
}

/**
 * Swaps the loaded copy in every attached profile that has the extension turned on. Unloads all
 * first so re-copying an unpacked folder never rewrites files another profile is running.
 */
export async function reloadBrowserExtensionWhereEnabled(
  extension: InstalledBrowserExtension,
  options: { refresh?: boolean } = {}
): Promise<void> {
  // SSH and This-device pages run their own copy too.
  const everyProfileId = [
    ...browserSessionRegistry.listProfiles().map((profile) => profile.id),
    ...listBrowserExtensionRouteProfileIds()
  ]
  const profileIds = everyProfileId.filter(
    (profileId) =>
      isEnabledIn(profileId, extension.id) && getBrowserExtensionSessionForProfile(profileId)
  )
  for (const profileId of profileIds) {
    unloadBrowserExtensionFromProfile(profileId, extension.id)
  }
  const attached = new Set(profileIds)
  getBrowserExtensionDnrStore().forgetSessionRulesOfOtherVersions(extension)
  // Profiles idle or going idle load the new copy, as a reload, when they reopen.
  noteBrowserExtensionReloadedWhileIdle(
    extension.id,
    everyProfileId.filter(
      (profileId) => isEnabledIn(profileId, extension.id) && !attached.has(profileId)
    )
  )
  // Why go on after a failure on refresh: every profile is already unloaded and nothing rolls an
  // unpacked reload back. A Web Store replace stops at the first failure, since its caller then
  // reloads the previous version.
  let prepareError: unknown
  if (options.refresh) {
    try {
      await prepareBrowserExtensionDirectory(extension, { refresh: true })
    } catch (error) {
      prepareError = error
    }
  }
  let firstLoadError: unknown
  // Why: a profile that went idle meanwhile gets onInstalled(update) when it reopens.
  const skipped = (profileId: string): void => {
    if (isEnabledIn(profileId, extension.id)) {
      noteBrowserExtensionReloadPendingInIdleProfile(profileId, extension.id)
    }
  }
  for (const profileId of profileIds) {
    // Why recheck: a Disable during an earlier await had no load of ours to cancel.
    if (!stillLoadsIn(profileId, extension.id)) {
      skipped(profileId)
      continue
    }
    if (prepareError !== undefined) {
      recordBrowserExtensionLoadFailure(profileId, extension.id, prepareError)
      continue
    }
    try {
      await loadBrowserExtensionIntoProfile(profileId, extension, 'reload')
    } catch (error) {
      // A Disable or idle stop that cancelled this load is not a reload failure.
      if (!stillLoadsIn(profileId, extension.id)) {
        skipped(profileId)
        continue
      }
      if (!options.refresh) {
        throw error
      }
      // Why record here too: a rejected profile startup fails the load before it records anything.
      recordBrowserExtensionLoadFailure(profileId, extension.id, error)
      firstLoadError ??= error
    }
  }
  if (prepareError !== undefined) {
    throw prepareError
  }
  if (firstLoadError !== undefined) {
    throw firstLoadError
  }
}
