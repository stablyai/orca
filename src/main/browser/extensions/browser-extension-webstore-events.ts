import { webContents } from 'electron'
import type { InstalledBrowserExtension } from '../../../shared/browser-extension-types'
import {
  BROWSER_EXTENSION_WEB_STORE_EVENT_CHANNEL,
  isChromeWebStoreUrl
} from '../../../shared/browser-extension-webstore'
import { getBrowserExtensionProfileIdForSession } from './browser-extension-api-host'
import { browserSessionRegistry } from '../browser-session-registry'

/** The subset of chrome.management.ExtensionInfo the store page reads. */
export function toChromeWebStoreExtensionInfo(
  extension: InstalledBrowserExtension
): Record<string, unknown> {
  return {
    id: extension.id,
    name: extension.name,
    shortName: extension.name,
    version: extension.version,
    enabled: true,
    mayDisable: true,
    isApp: false,
    type: 'extension',
    installType: extension.source === 'webstore' ? 'normal' : 'development'
  }
}

/** Why store tabs only: the installed list is a fingerprint, so no other origin ever receives it. */
function sendToChromeWebStorePages(
  event: 'onInstalled' | 'onUninstalled',
  args: unknown[],
  enabledExtensionId?: string
): void {
  for (const contents of webContents.getAllWebContents()) {
    if (contents.isDestroyed() || contents.getType() !== 'webview') {
      continue
    }
    const profileId = getBrowserExtensionProfileIdForSession(contents.session)
    if (
      !profileId ||
      (enabledExtensionId &&
        !browserSessionRegistry.getEnabledExtensionIds(profileId).includes(enabledExtensionId))
    ) {
      continue
    }
    const frame = contents.mainFrame
    if (!isChromeWebStoreUrl(frame.url)) {
      continue
    }
    try {
      frame.send(BROWSER_EXTENSION_WEB_STORE_EVENT_CHANNEL, { event, args })
    } catch {
      // The frame went away mid-loop.
    }
  }
}

/** The store page re-reads its button state only on these events. */
export function notifyChromeWebStoreInstalled(extension: InstalledBrowserExtension): void {
  sendToChromeWebStorePages('onInstalled', [toChromeWebStoreExtensionInfo(extension)], extension.id)
}

export function notifyChromeWebStoreUninstalled(extensionId: string): void {
  sendToChromeWebStorePages('onUninstalled', [extensionId])
}
