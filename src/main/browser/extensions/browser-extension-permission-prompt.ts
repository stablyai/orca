import { browserSessionRegistry } from '../browser-session-registry'
import { requestBrowserExtensionInstallPrompt } from './browser-extension-install-prompt'
import { getBrowserExtensionInstallStore } from './browser-extension-install-store'
import { readBrowserExtensionIconDataUrl } from './browser-extension-manifest'
import type { BrowserExtensionPermissionSet } from './browser-extension-permission-grants'
import { getBrowserExtensionMainWindow } from './browser-extension-window-model'

/**
 * permissions.request asks through Orca's extension dialog (the one store installs use), listing
 * only the access not yet granted. Without Orca's window there is no one to ask, so it declines.
 */
export async function askToGrantBrowserExtensionPermissions(
  browserProfileId: string,
  extension: Electron.Extension,
  add: BrowserExtensionPermissionSet
): Promise<boolean> {
  const window = getBrowserExtensionMainWindow()
  if (!window || window.isDestroyed()) {
    return false
  }
  const installed = getBrowserExtensionInstallStore().get(extension.id)
  return requestBrowserExtensionInstallPrompt(window.webContents, {
    kind: 'permissions',
    name: installed?.name ?? extension.name,
    iconDataUrl: installed
      ? await readBrowserExtensionIconDataUrl(installed.path, installed.iconPath)
      : null,
    permissions: add.permissions,
    hostPermissions: add.origins,
    profileLabel: browserSessionRegistry.getProfile(browserProfileId)?.label ?? null
  })
}
