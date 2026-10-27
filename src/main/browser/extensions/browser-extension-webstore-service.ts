import { webContents } from 'electron'
import type { InstalledBrowserExtension } from '../../../shared/browser-extension-types'
import {
  parseChromeWebStoreExtensionInput,
  type BrowserExtensionWebStoreInstallResult
} from '../../../shared/browser-extension-webstore'
import { browserManager } from '../browser-manager'
import { browserSessionRegistry } from '../browser-session-registry'
import { getBrowserExtensionInstallStore } from './browser-extension-install-store'
import { requestBrowserExtensionInstallPrompt } from './browser-extension-install-prompt'
import { removeBrowserExtension } from './browser-extension-management'
import { readBrowserExtensionIconDataUrl } from './browser-extension-manifest'
import {
  samePermissionSummary,
  type BrowserExtensionPermissionSummary
} from './browser-extension-permission-summary'
import { getBrowserExtensionSessionForProfile } from './browser-extension-session-loader'
import { isBrowserExtensionSupportEnabled } from './browser-extension-support'
import {
  downloadWebStoreCrx,
  fetchWebStoreIconDataUrl,
  isAllowedWebStoreIconUrl
} from './browser-extension-webstore-download'
import {
  notifyChromeWebStoreInstalled,
  notifyChromeWebStoreUninstalled
} from './browser-extension-webstore-events'
import {
  commitStagedWebStoreExtension,
  discardStagedWebStoreExtension,
  isBrowserExtensionBusy,
  stageWebStoreExtension,
  withBrowserExtensionLock
} from './browser-extension-webstore-install'
import {
  ChromeWebStoreInstallFlow,
  InvalidIconUrlError,
  type ChromeWebStoreFrame
} from './browser-extension-webstore-install-flow'

/** Real dependencies for the store page flow, plus the Settings "Add from Chrome Web Store" action. */

export function isBrowserExtensionEnabledInProfile(
  profileId: string,
  extensionId: string
): boolean {
  return (
    getBrowserExtensionInstallStore().get(extensionId) !== null &&
    browserSessionRegistry.getEnabledExtensionIds(profileId).includes(extensionId)
  )
}

function profileLabel(profileId: string): string | null {
  return browserSessionRegistry.getProfile(profileId)?.label ?? null
}

function liveGuest(frame: ChromeWebStoreFrame): Electron.WebContents | null {
  const guest = webContents.fromId(frame.webContentsId)
  return guest && !guest.isDestroyed() ? guest : null
}

async function installApprovedFromStore(
  frame: ChromeWebStoreFrame,
  extensionId: string,
  approved: BrowserExtensionPermissionSummary
): Promise<InstalledBrowserExtension> {
  return withBrowserExtensionLock(extensionId, async () => {
    const staged = await stageWebStoreExtension(await downloadWebStoreCrx(extensionId))
    if (!samePermissionSummary(staged.access, approved)) {
      await discardStagedWebStoreExtension(staged)
      throw new Error('The downloaded extension asks for different access than the store listed')
    }
    if (!frame.isStillValid()) {
      await discardStagedWebStoreExtension(staged)
      throw new Error('The store page closed before the install finished')
    }
    return commitStagedWebStoreExtension(staged, frame.profileId)
  })
}

export const chromeWebStoreInstallFlow = new ChromeWebStoreInstallFlow({
  now: () => Date.now(),
  isEnabledInProfile: isBrowserExtensionEnabledInProfile,
  isBusy: isBrowserExtensionBusy,
  profileLabel,
  loadIcon: async (_frame, iconUrl) => {
    if (!isAllowedWebStoreIconUrl(iconUrl)) {
      throw new InvalidIconUrlError('Invalid icon url')
    }
    // Why not the tab's session.fetch: it fails once a request-blocking extension loads there (electron#54685).
    return fetchWebStoreIconDataUrl(iconUrl)
  },
  confirm: async (frame, prompt) => {
    const guest = liveGuest(frame)
    const context = guest ? browserManager.getRendererContextForGuest(guest.id) : null
    if (!guest || !context) {
      return false
    }
    return requestBrowserExtensionInstallPrompt(context.renderer, prompt, guest)
  },
  install: installApprovedFromStore,
  describeInstalled: async (extensionId) => {
    const installed = getBrowserExtensionInstallStore().get(extensionId)
    return installed
      ? {
          name: installed.name,
          iconDataUrl: await readBrowserExtensionIconDataUrl(installed.path, installed.iconPath)
        }
      : null
  },
  uninstall: async (extensionId) => {
    const result = await removeBrowserExtension(extensionId)
    if (!result.ok) {
      throw new Error(result.error)
    }
  },
  // Why deferred: Chrome answers the page's callback before raising the management event.
  notifyInstalled: (extension) => setImmediate(() => notifyChromeWebStoreInstalled(extension)),
  notifyUninstalled: (extensionId) =>
    setImmediate(() => notifyChromeWebStoreUninstalled(extensionId))
})

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

/** Settings: download and verify first, so the prompt shows what the package really asks for. */
export async function installBrowserExtensionFromWebStore(
  profileId: string,
  input: string,
  renderer: Electron.WebContents
): Promise<BrowserExtensionWebStoreInstallResult> {
  if (!isBrowserExtensionSupportEnabled()) {
    return { status: 'failed', error: 'Turn on browser extensions in Settings › Experimental' }
  }
  const extensionId = parseChromeWebStoreExtensionInput(input)
  if (!extensionId) {
    return {
      status: 'failed',
      error: 'Paste a Chrome Web Store link or a 32-letter extension ID'
    }
  }
  if (!getBrowserExtensionSessionForProfile(profileId)) {
    return { status: 'failed', error: 'Browser profile is not available for extensions' }
  }
  const existing = getBrowserExtensionInstallStore().get(extensionId)
  if (existing && isBrowserExtensionEnabledInProfile(profileId, extensionId)) {
    return { status: 'failed', error: `${existing.name} is already added` }
  }
  try {
    return await withBrowserExtensionLock(extensionId, async () => {
      const staged = await stageWebStoreExtension(await downloadWebStoreCrx(extensionId))
      let accepted = false
      try {
        accepted = await requestBrowserExtensionInstallPrompt(renderer, {
          kind: 'install',
          name: staged.summary.name,
          iconDataUrl: await readBrowserExtensionIconDataUrl(
            staged.directory,
            staged.summary.iconPath
          ),
          permissions: staged.access.permissions,
          hostPermissions: staged.access.hostPermissions,
          profileLabel: profileLabel(profileId)
        })
      } finally {
        if (!accepted) {
          await discardStagedWebStoreExtension(staged)
        }
      }
      if (!accepted) {
        return { status: 'cancelled' } as const
      }
      const installed = await commitStagedWebStoreExtension(staged, profileId)
      notifyChromeWebStoreInstalled(installed)
      return { status: 'installed', name: installed.name } as const
    })
  } catch (error) {
    return { status: 'failed', error: errorMessage(error) }
  }
}
