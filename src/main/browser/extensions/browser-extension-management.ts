import { isAbsolute } from 'node:path'
import type {
  BrowserExtensionActionResult,
  BrowserExtensionListResult,
  InstalledBrowserExtension
} from '../../../shared/browser-extension-types'
import { browserSessionRegistry } from '../browser-session-registry'
import { openBrowserExtensionOptionsPage } from './api/runtime'
import { getBrowserExtensionInstallStore } from './browser-extension-install-store'
import { reloadBrowserExtensionWhereEnabled } from './browser-extension-profile-reload'
import {
  readBrowserExtensionIconDataUrl,
  readBrowserExtensionManifest
} from './browser-extension-manifest'
import {
  getBrowserExtensionSessionForProfile,
  listBrowserExtensionSessions,
  loadBrowserExtensionFolderIntoProfile,
  loadBrowserExtensionIntoProfile,
  unloadBrowserExtensionEverywhere,
  unloadBrowserExtensionFromProfile
} from './browser-extension-session-loader'
import { clearBrowserExtensionSessionData } from './browser-extension-data-removal'
import {
  forgetHeldBrowserExtensionUpdate,
  getHeldBrowserExtensionUpdate
} from './browser-extension-held-updates'
import { browserExtensionIdForUnpackedFolder } from './browser-extension-load-directory'
import {
  forgetBrowserExtensionLoadFailures,
  getBrowserExtensionLoadFailure
} from './browser-extension-load-errors'
import { notifyBrowserExtensionListChanged } from './browser-extension-list-changes'
import { reviewHeldBrowserExtensionUpdate } from './browser-extension-webstore-updater'
import { isBrowserExtensionSupportEnabled } from './browser-extension-support'
import { withExtensionEnabled, withoutExtension } from './browser-extension-profile-enablement'
import { forgetPinnedBrowserExtension } from './browser-extension-toolbar-pins'
import { getBrowserExtensionProfileStateStore } from './browser-extension-profile-state-store'
import { getBrowserExtensionSyncStorageStore } from './browser-extension-sync-storage-store'
import { notifyChromeWebStoreUninstalled } from './browser-extension-webstore-events'

/** Settings actions. Each returns a result instead of throwing so the renderer can show the reason. */

async function settle(action: () => Promise<void>): Promise<BrowserExtensionActionResult> {
  if (!isBrowserExtensionSupportEnabled()) {
    return { ok: false, error: 'Restart Orca to turn on browser extensions' }
  }
  try {
    await action()
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function listBrowserExtensionsForProfile(
  browserProfileId: string
): Promise<BrowserExtensionListResult> {
  if (!isBrowserExtensionSupportEnabled()) {
    return { active: false, extensions: [] }
  }
  const enabled = new Set(browserSessionRegistry.getEnabledExtensionIds(browserProfileId))
  const installed = getBrowserExtensionInstallStore().list()
  const extensions = await Promise.all(
    installed.map(async (extension) => ({
      id: extension.id,
      name: extension.name,
      version: extension.version,
      source: extension.source,
      enabled: enabled.has(extension.id),
      iconDataUrl: await readBrowserExtensionIconDataUrl(extension.path, extension.iconPath),
      hasOptionsPage: extension.optionsPage !== null,
      permissions: extension.permissions,
      loadError: enabled.has(extension.id)
        ? getBrowserExtensionLoadFailure(browserProfileId, extension.id)
        : null,
      heldUpdateVersion: getHeldBrowserExtensionUpdate(extension.id)?.version ?? null
    }))
  )
  return { active: true, extensions: extensions.sort((a, b) => a.name.localeCompare(b.name)) }
}

export function setBrowserExtensionEnabled(
  browserProfileId: string,
  extensionId: string,
  enabled: boolean
): Promise<BrowserExtensionActionResult> {
  return settle(async () => {
    const installed = getBrowserExtensionInstallStore().get(extensionId)
    if (!installed) {
      throw new Error('Extension is not installed')
    }
    if (!browserSessionRegistry.getProfile(browserProfileId)) {
      throw new Error('Browser profile not found')
    }
    if (enabled) {
      await loadBrowserExtensionIntoProfile(browserProfileId, installed)
    } else {
      unloadBrowserExtensionFromProfile(browserProfileId, extensionId)
    }
    browserSessionRegistry.updateEnabledExtensionIds((byProfile) =>
      withExtensionEnabled(byProfile, browserProfileId, extensionId, enabled)
    )
  })
}

/** Best effort per profile: leftover data must not keep the extension installed. */
async function clearBrowserExtensionDataEverywhere(extensionId: string): Promise<void> {
  await Promise.all(
    listBrowserExtensionSessions().map((sess) =>
      clearBrowserExtensionSessionData(sess, extensionId).catch((error: unknown) => {
        console.warn(`[browser-extensions] Could not clear data for ${extensionId}:`, error)
      })
    )
  )
}

/** Removes the extension from every profile (Orca installs once, enables per profile), data included. */
export function removeBrowserExtension(extensionId: string): Promise<BrowserExtensionActionResult> {
  return settle(async () => {
    // Why first: chrome.storage can only be cleared through the still-loaded extension.
    await clearBrowserExtensionDataEverywhere(extensionId)
    unloadBrowserExtensionEverywhere(extensionId)
    browserSessionRegistry.updateEnabledExtensionIds((byProfile) =>
      withoutExtension(byProfile, extensionId)
    )
    forgetPinnedBrowserExtension(extensionId)
    getBrowserExtensionProfileStateStore().forgetExtension(extensionId)
    getBrowserExtensionSyncStorageStore().forgetExtension(extensionId)
    forgetBrowserExtensionLoadFailures({ extensionId })
    forgetHeldBrowserExtensionUpdate(extensionId)
    await getBrowserExtensionInstallStore().remove(extensionId)
    notifyChromeWebStoreUninstalled(extensionId)
    notifyBrowserExtensionListChanged()
  })
}

/** Settings › Review access for an update held because it asks for more. */
export function reviewBrowserExtensionUpdate(
  extensionId: string,
  renderer: Electron.WebContents
): Promise<BrowserExtensionActionResult> {
  return settle(() => reviewHeldBrowserExtensionUpdate(extensionId, renderer))
}

/** Settings › Reload for an unpacked extension: re-copies the folder and restarts it everywhere. */
export function reloadUnpackedBrowserExtension(
  extensionId: string
): Promise<BrowserExtensionActionResult> {
  return settle(async () => {
    const store = getBrowserExtensionInstallStore()
    const installed = store.get(extensionId)
    if (installed?.source !== 'unpacked') {
      throw new Error('Only unpacked extensions can be reloaded')
    }
    const summary = await readBrowserExtensionManifest(installed.path)
    const record: InstalledBrowserExtension = {
      ...installed,
      name: summary.name,
      version: summary.version,
      iconPath: summary.iconPath,
      permissions: summary.permissions,
      hostPermissions: summary.hostPermissions,
      optionsPage: summary.optionsPage
    }
    store.save(record)
    await reloadBrowserExtensionWhereEnabled(record, { refresh: true })
  })
}

/** Developer "Load unpacked…": loaded from Orca's copy, enabled for the profile it was added from. */
export function addUnpackedBrowserExtension(
  browserProfileId: string,
  directory: string
): Promise<BrowserExtensionActionResult> {
  return settle(async () => {
    if (!isAbsolute(directory)) {
      throw new Error('Choose an extension folder')
    }
    const store = getBrowserExtensionInstallStore()
    const summary = await readBrowserExtensionManifest(directory)
    // Why before loading: a refused folder must leave no loaded copy and no rewritten profile records.
    const existing = store.get(await browserExtensionIdForUnpackedFolder(directory))
    if (existing?.source === 'webstore') {
      throw new Error(`${existing.name} is already installed from the Chrome Web Store`)
    }
    const loaded = await loadBrowserExtensionFolderIntoProfile(browserProfileId, directory)
    store.save({
      id: loaded.id,
      name: summary.name,
      version: loaded.version,
      path: directory,
      source: 'unpacked',
      iconPath: summary.iconPath,
      permissions: summary.permissions,
      hostPermissions: summary.hostPermissions,
      optionsPage: summary.optionsPage
    })
    browserSessionRegistry.updateEnabledExtensionIds((byProfile) =>
      withExtensionEnabled(byProfile, browserProfileId, loaded.id, true)
    )
    notifyBrowserExtensionListChanged()
  })
}

export function openBrowserExtensionOptions(
  browserProfileId: string,
  extensionId: string
): Promise<BrowserExtensionActionResult> {
  return settle(async () => {
    const extension =
      getBrowserExtensionSessionForProfile(browserProfileId)?.extensions.getExtension(extensionId)
    if (!extension) {
      throw new Error('Turn the extension on to open its options')
    }
    await openBrowserExtensionOptionsPage(browserProfileId, extension)
  })
}
