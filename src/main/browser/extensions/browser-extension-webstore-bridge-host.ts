import { ipcMain } from 'electron'
import { z } from 'zod'
import {
  BROWSER_EXTENSION_WEB_STORE_CHANNEL,
  isChromeWebStoreUrl,
  type ChromeWebStoreReply
} from '../../../shared/browser-extension-webstore'
import { browserManager } from '../browser-manager'
import { getBrowserExtensionProfileIdForSession } from './browser-extension-api-host'
import { getBrowserExtensionInstallStore } from './browser-extension-install-store'
import { toChromeWebStoreExtensionInfo } from './browser-extension-webstore-events'
import {
  chromeWebStoreExtensionStatus,
  type ChromeWebStoreFrame
} from './browser-extension-webstore-install-flow'
import {
  chromeWebStoreInstallFlow,
  isBrowserExtensionEnabledInProfile
} from './browser-extension-webstore-service'

/** The store page's one IPC channel: every call is checked against the sender, never the payload. */

const idArg = z.string().max(64)
const requestSchema = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('beginInstallWithManifest3'),
    args: z
      .tuple([
        z.object({
          id: idArg,
          manifest: z.string().min(1).max(2_000_000),
          localizedName: z.string().max(1000).nullish(),
          iconUrl: z.string().max(8192).nullish()
        })
      ])
      .rest(z.unknown())
  }),
  z.object({ method: z.literal('completeInstall'), args: z.tuple([idArg]).rest(z.unknown()) }),
  z.object({
    method: z.literal('getExtensionStatus'),
    args: z.tuple([idArg, z.string().max(2_000_000).nullish()]).rest(z.unknown())
  }),
  z.object({ method: z.literal('management.getAll'), args: z.array(z.unknown()) }),
  z.object({ method: z.literal('management.uninstall'), args: z.tuple([idArg]).rest(z.unknown()) }),
  z.object({
    method: z.literal('management.setEnabled'),
    args: z.tuple([idArg, z.boolean()]).rest(z.unknown())
  })
])

type StoreSenderLookups = {
  isOrcaBrowserTab: (webContentsId: number) => boolean
  profileIdForSession: (session: Electron.Session) => string | null
}

const defaultLookups: StoreSenderLookups = {
  isOrcaBrowserTab: (webContentsId) =>
    browserManager.getTabIdForWebContentsId(webContentsId) !== null,
  profileIdForSession: getBrowserExtensionProfileIdForSession
}

/**
 * The caller must be the top frame of an Orca browser tab, in a local browser profile that runs
 * extensions, whose document is exactly https://chromewebstore.google.com.
 */
export function resolveChromeWebStoreFrame(
  event: { sender: Electron.WebContents; senderFrame: Electron.WebFrameMain | null },
  lookups: StoreSenderLookups = defaultLookups
): ChromeWebStoreFrame | null {
  const { sender, senderFrame: frame } = event
  if (!frame || sender.isDestroyed() || frame.isDestroyed() || sender.getType() !== 'webview') {
    return null
  }
  if (frame.parent !== null || !isChromeWebStoreUrl(frame.url)) {
    return null
  }
  const profileId = lookups.profileIdForSession(sender.session)
  if (!profileId || !lookups.isOrcaBrowserTab(sender.id)) {
    return null
  }
  return {
    webContentsId: sender.id,
    frameTreeNodeId: frame.frameTreeNodeId,
    profileId,
    isStillValid: () =>
      !sender.isDestroyed() &&
      !frame.isDestroyed() &&
      frame.parent === null &&
      isChromeWebStoreUrl(frame.url) &&
      lookups.profileIdForSession(sender.session) === profileId &&
      lookups.isOrcaBrowserTab(sender.id)
  }
}

function listEnabledForProfile(profileId: string): Record<string, unknown>[] {
  return getBrowserExtensionInstallStore()
    .list()
    .filter((extension) => isBrowserExtensionEnabledInProfile(profileId, extension.id))
    .map(toChromeWebStoreExtensionInfo)
}

async function dispatch(
  frame: ChromeWebStoreFrame,
  rawRequest: unknown
): Promise<ChromeWebStoreReply> {
  const parsed = requestSchema.safeParse(rawRequest)
  if (!parsed.success) {
    return { error: 'Invalid arguments' }
  }
  const request = parsed.data
  switch (request.method) {
    case 'beginInstallWithManifest3': {
      const { id, manifest, localizedName, iconUrl } = request.args[0]
      return chromeWebStoreInstallFlow.begin(frame, {
        id,
        manifest,
        localizedName: localizedName ?? undefined,
        iconUrl: iconUrl ?? undefined
      })
    }
    case 'completeInstall':
      return chromeWebStoreInstallFlow.complete(frame, request.args[0])
    case 'getExtensionStatus': {
      const [extensionId, manifest] = request.args
      return {
        value: chromeWebStoreExtensionStatus(
          isBrowserExtensionEnabledInProfile(frame.profileId, extensionId),
          manifest ?? null
        )
      }
    }
    case 'management.getAll':
      return { value: listEnabledForProfile(frame.profileId) }
    case 'management.uninstall':
      return chromeWebStoreInstallFlow.uninstall(frame, request.args[0])
    case 'management.setEnabled': {
      const [extensionId, enabled] = request.args
      // Why: the store only asks to enable; turning extensions on or off stays in Settings.
      return enabled && isBrowserExtensionEnabledInProfile(frame.profileId, extensionId)
        ? {}
        : { error: 'Turn extensions on or off in Orca Settings' }
    }
  }
}

export function installChromeWebStoreBridgeHost(): void {
  ipcMain.removeHandler(BROWSER_EXTENSION_WEB_STORE_CHANNEL)
  ipcMain.handle(BROWSER_EXTENSION_WEB_STORE_CHANNEL, (event, request: unknown) => {
    const frame = resolveChromeWebStoreFrame(event)
    if (!frame) {
      return { error: 'Not allowed' } satisfies ChromeWebStoreReply
    }
    return dispatch(frame, request)
  })
}
