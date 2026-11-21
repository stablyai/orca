import { CHROME_WEB_STORE_ORIGIN } from '../../../../shared/browser/extensions/browser-extension-webstore'

type ChromeResourceType =
  | 'main_frame'
  | 'sub_frame'
  | 'stylesheet'
  | 'script'
  | 'image'
  | 'font'
  | 'object'
  | 'xmlhttprequest'
  | 'ping'
  | 'csp_report'
  | 'media'
  | 'websocket'
  | 'other'

const CHROME_RESOURCE_TYPES = new Map<string, ChromeResourceType>([
  ['mainFrame', 'main_frame'],
  ['subFrame', 'sub_frame'],
  ['stylesheet', 'stylesheet'],
  ['script', 'script'],
  ['image', 'image'],
  ['font', 'font'],
  ['object', 'object'],
  ['xhr', 'xmlhttprequest'],
  ['ping', 'ping'],
  ['cspReport', 'csp_report'],
  ['media', 'media'],
  ['webSocket', 'websocket']
])

/** Electron's resourceType → Chrome's, shared by webRequest and declarativeNetRequest. */
export function chromeResourceType(resourceType: string): ChromeResourceType {
  return CHROME_RESOURCE_TYPES.get(resourceType) ?? 'other'
}

const WEB_URL = /^(?:https?|wss?):/i

/** WebRequestPermissions::HideRequest: requests extensions never see or act on. */
export function isRequestHiddenFromExtensions(details: {
  url: string
  webContentsId?: number
  initiatorOrigin?: string
}): boolean {
  if (!WEB_URL.test(details.url)) {
    return true
  }
  // Orca's own main-process requests carry neither a webContents nor an initiator.
  if (details.webContentsId === undefined && details.initiatorOrigin === undefined) {
    return true
  }
  return (
    details.url.startsWith(`${CHROME_WEB_STORE_ORIGIN}/`) ||
    details.url.startsWith('https://chrome.google.com/webstore')
  )
}
