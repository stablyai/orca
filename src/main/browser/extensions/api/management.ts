/// <reference types="chrome" />
import { z } from 'zod'
import { getChromeExtensionOrigin } from '../../../../shared/browser-extension-url'
import type { InstalledBrowserExtension } from '../../../../shared/browser-extension-types'
import { browserSessionRegistry } from '../../browser-session-registry'
import { getBrowserExtensionInstallStore } from '../browser-extension-install-store'
import { notifyBrowserExtensionListChanged } from '../browser-extension-list-changes'
import { setBrowserExtensionEnabled } from '../browser-extension-management'
import {
  BrowserExtensionApiError,
  defineBrowserExtensionMethod,
  registerBrowserExtensionNamespace,
  type BrowserExtensionCaller
} from '../browser-extension-namespace-registry'
import { hasBrowserExtensionUserGesture } from './permissions'

/**
 * chrome.management for extensions that declare "management": Orca's installed list as the
 * caller's profile sees it. Electron's own getSelf/uninstallSelf stay native.
 */

function manifestString(manifest: Record<string, unknown> | undefined, key: string): string | null {
  const value = manifest?.[key]
  return typeof value === 'string' ? value : null
}

function manifestIcons(
  extensionId: string,
  manifest: Record<string, unknown> | undefined
): chrome.management.IconInfo[] | undefined {
  const icons = manifest?.icons
  if (!icons || typeof icons !== 'object') {
    return undefined
  }
  return Object.entries(icons).flatMap(([size, path]) =>
    typeof path === 'string' && Number.parseInt(size, 10) > 0
      ? [
          {
            size: Number.parseInt(size, 10),
            url: `${getChromeExtensionOrigin(extensionId)}/${path.replace(/^\/+/, '')}`
          }
        ]
      : []
  )
}

/**
 * Chrome's ExtensionInfo. `loaded` is the extension as this profile's session runs it (present
 * only while enabled there); description and icons come from it.
 */
export function describeManagedBrowserExtension(
  installed: InstalledBrowserExtension,
  enabled: boolean,
  loaded: Pick<Electron.Extension, 'manifest'> | null
): chrome.management.ExtensionInfo {
  const manifest: Record<string, unknown> | undefined = loaded?.manifest
  const icons = manifestIcons(installed.id, manifest)
  const homepageUrl = manifestString(manifest, 'homepage_url')
  return {
    id: installed.id,
    name: installed.name,
    shortName: manifestString(manifest, 'short_name') ?? installed.name,
    description: manifestString(manifest, 'description') ?? '',
    version: installed.version,
    mayDisable: true,
    enabled,
    ...(enabled ? {} : { disabledReason: 'unknown' as const }),
    isApp: false,
    type: 'extension',
    offlineEnabled: false,
    optionsUrl: installed.optionsPage
      ? `${getChromeExtensionOrigin(installed.id)}/${installed.optionsPage.replace(/^\/+/, '')}`
      : '',
    ...(homepageUrl ? { homepageUrl } : {}),
    ...(icons && icons.length > 0 ? { icons } : {}),
    permissions: installed.permissions,
    hostPermissions: installed.hostPermissions,
    // Chrome reports unpacked extensions as development installs.
    installType: installed.source === 'unpacked' ? 'development' : 'normal'
  }
}

function listForCaller(caller: BrowserExtensionCaller): chrome.management.ExtensionInfo[] {
  const enabledIds = new Set(browserSessionRegistry.getEnabledExtensionIds(caller.browserProfileId))
  return getBrowserExtensionInstallStore()
    .list()
    .map((installed) =>
      describeManagedBrowserExtension(
        installed,
        enabledIds.has(installed.id),
        caller.session.extensions.getExtension(installed.id)
      )
    )
}

function requireManaged(
  caller: BrowserExtensionCaller,
  id: string
): chrome.management.ExtensionInfo {
  const info = listForCaller(caller).find((entry) => entry.id === id)
  if (!info) {
    throw new BrowserExtensionApiError(`Failed to find extension with id ${id}.`)
  }
  return info
}

async function setEnabled(
  caller: BrowserExtensionCaller,
  id: string,
  enabled: boolean
): Promise<void> {
  if (id === caller.extension.id) {
    throw new BrowserExtensionApiError('An extension cannot enable or disable itself')
  }
  const target = requireManaged(caller, id)
  if (target.enabled === enabled) {
    return
  }
  // Chrome lets an extension turn others on only from a user gesture.
  if (enabled && !hasBrowserExtensionUserGesture(caller)) {
    throw new BrowserExtensionApiError('This function must be called during a user gesture')
  }
  const result = await setBrowserExtensionEnabled(caller.browserProfileId, id, enabled)
  if (!result.ok) {
    throw new BrowserExtensionApiError(result.error)
  }
  notifyBrowserExtensionListChanged()
}

export function registerManagementNamespace(): void {
  registerBrowserExtensionNamespace('management', {
    permission: 'management',
    methods: {
      getAll: defineBrowserExtensionMethod(z.tuple([]), listForCaller),
      get: defineBrowserExtensionMethod(z.tuple([z.string()]), requireManaged),
      setEnabled: defineBrowserExtensionMethod(z.tuple([z.string(), z.boolean()]), setEnabled)
    },
    events: []
  })
}
