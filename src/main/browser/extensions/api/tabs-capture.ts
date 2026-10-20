import { z } from 'zod'
import { parseChromeExtensionUrl } from '../../../../shared/browser-extension-url'
import { isChromeWebStoreUrl } from '../../../../shared/browser-extension-webstore'
import { hasBrowserExtensionActiveTab } from '../browser-extension-active-tab'
import {
  BrowserExtensionApiError,
  defineBrowserExtensionMethod,
  type BrowserExtensionCaller
} from '../browser-extension-namespace-registry'
import { listBrowserExtensionTabs, resolveCallerWindowId } from '../browser-extension-tab-model'
import { WINDOW_ID_CURRENT, getBrowserExtensionWindow } from '../browser-extension-window-model'
import { browserExtensionHostPatternsInSession } from './permissions'

// Chrome's default JPEG quality for tabs.captureVisibleTab.
const DEFAULT_JPEG_QUALITY = 90

const imageDetailsSchema = z
  .object({ format: z.enum(['jpeg', 'png']), quality: z.number().int().min(0).max(100) })
  .partial()
  .loose()

type ImageDetails = z.infer<typeof imageDetailsSchema>

/** Chrome's rule: `<all_urls>` or an activeTab grant for the tab, never another extension's page or the store. */
function captureVisibleTabDenial(
  extensionId: string,
  hostPatterns: readonly string[],
  hasActiveTab: boolean,
  url: string
): string | null {
  if (!hasActiveTab && !hostPatterns.includes('<all_urls>')) {
    return "Either the '<all_urls>' or 'activeTab' permission is required."
  }
  const extensionPage = parseChromeExtensionUrl(url)
  if (extensionPage && extensionPage.extensionId !== extensionId) {
    return 'Cannot access a chrome-extension:// URL of different extension'
  }
  if (isChromeWebStoreUrl(url)) {
    return 'The extensions gallery cannot be scripted.'
  }
  return null
}

function encodeCapturedTab(image: Electron.NativeImage, details: ImageDetails): string {
  if (details.format === 'png') {
    return `data:image/png;base64,${image.toPNG().toString('base64')}`
  }
  const quality = details.quality ?? DEFAULT_JPEG_QUALITY
  return `data:image/jpeg;base64,${image.toJPEG(quality).toString('base64')}`
}

async function captureVisibleTab(
  caller: BrowserExtensionCaller,
  windowId: number | null | undefined,
  details: ImageDetails
): Promise<string> {
  const resolvedId =
    windowId == null || windowId === WINDOW_ID_CURRENT ? resolveCallerWindowId(caller) : windowId
  if (resolvedId === null || !getBrowserExtensionWindow(resolvedId)) {
    throw new BrowserExtensionApiError(`No window with id: ${windowId ?? WINDOW_ID_CURRENT}.`)
  }
  const tab = listBrowserExtensionTabs(caller.session).find(
    (entry) => entry.windowId === resolvedId && entry.active
  )
  if (!tab) {
    throw new BrowserExtensionApiError('No active web contents to capture')
  }
  const denial = captureVisibleTabDenial(
    caller.extension.id,
    browserExtensionHostPatternsInSession(caller.extension, caller.session),
    hasBrowserExtensionActiveTab(caller.extension.id, tab.contents.id),
    tab.contents.getURL()
  )
  if (denial) {
    throw new BrowserExtensionApiError(denial)
  }
  const image = await tab.contents.capturePage()
  if (image.isEmpty()) {
    throw new BrowserExtensionApiError(
      'Internal error while trying to capture visible region of the current tab'
    )
  }
  return encodeCapturedTab(image, details)
}

/** tabs.captureVisibleTab(windowId?, options?): the active tab of the window, as a data URL. */
export const captureVisibleTabMethod = defineBrowserExtensionMethod(
  z.tuple([
    z.union([z.number().int(), imageDetailsSchema]).nullable().optional(),
    imageDetailsSchema.nullable().optional()
  ]),
  (caller, first, second) =>
    typeof first === 'object' && first !== null
      ? captureVisibleTab(caller, null, first)
      : captureVisibleTab(caller, first, second ?? {})
)
