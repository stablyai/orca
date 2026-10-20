import { installBrowserSessionHeadersReceived } from '../browser-session-request-decisions'
import {
  setBrowserSessionWebRequestObserver,
  type ObservedWebRequestDetails,
  type ObservedWebRequestEvent
} from '../browser-session-web-request-observer'
import { chromeFrameDocument } from './api/web-navigation'
import { browserExtensionHostPatternsInSession } from './api/permissions'
import {
  emitBrowserExtensionEvent,
  getBrowserExtensionProfileIdForSession
} from './browser-extension-api-host'
import { browserExtensionEventHasListener } from './browser-extension-contexts'
import { matchesExtensionMatchPattern } from './browser-extension-match-pattern'
import { extensionHasPermission } from './browser-extension-namespace-registry'
import { hasBrowserExtensionHostPermission } from './browser-extension-permission-grants'
import { resolveBrowserExtensionTab } from './browser-extension-tab-model'

/**
 * chrome.webRequest, observed rather than blocking. Electron 43 delivers no webRequest events to
 * MV3 workers, and Orca's own session handlers switch Electron's extension webRequest off anyway,
 * so Orca forwards what its handlers see. MV3 store extensions cannot block requests in Chrome
 * either (webRequestBlocking is policy-only), so nothing they could do is lost.
 */

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

// Chrome hides these unless a listener asks for 'extraHeaders'.
const HIDDEN_REQUEST_HEADERS = new Set(['accept-language', 'accept-encoding', 'referer', 'cookie'])
const HIDDEN_RESPONSE_HEADERS = new Set(['set-cookie'])

export type ChromeWebRequestDetails = {
  requestId: string
  url: string
  method: string
  frameId: number
  parentFrameId: number
  tabId: number
  windowId: number
  type: string
  timeStamp: number
  frameType?: 'outermost_frame' | 'sub_frame'
  documentId?: string
  parentDocumentId?: string
  documentLifecycle?: 'active'
  requestHeaders?: { name: string; value: string }[]
  responseHeaders?: { name: string; value: string }[]
  statusCode?: number
  statusLine?: string
  fromCache?: boolean
  ip?: string
  redirectUrl?: string
  error?: string
}

function requestHeaderList(headers: Record<string, string>): { name: string; value: string }[] {
  return Object.entries(headers)
    .filter(([name]) => !HIDDEN_REQUEST_HEADERS.has(name.toLowerCase()))
    .map(([name, value]) => ({ name, value }))
}

function responseHeaderList(headers: Record<string, string[]>): { name: string; value: string }[] {
  return Object.entries(headers)
    .filter(([name]) => !HIDDEN_RESPONSE_HEADERS.has(name.toLowerCase()))
    .flatMap(([name, values]) => values.map((value) => ({ name, value })))
}

type WebRequestFrameFields = Pick<
  ChromeWebRequestDetails,
  | 'frameId'
  | 'parentFrameId'
  | 'frameType'
  | 'documentId'
  | 'parentDocumentId'
  | 'documentLifecycle'
>

/** A navigation request has no document yet; any other request belongs to its frame's current one. */
function frameFields(details: ObservedWebRequestDetails): WebRequestFrameFields {
  if (details.resourceType === 'mainFrame') {
    return {
      frameId: 0,
      parentFrameId: -1,
      frameType: 'outermost_frame',
      documentLifecycle: 'active'
    }
  }
  const frame = details.frame && !details.frame.isDestroyed() ? details.frame : null
  return frame
    ? chromeFrameDocument(frame, details.resourceType !== 'subFrame')
    : { frameId: 0, parentFrameId: -1 }
}

export function toChromeWebRequestDetails(
  details: ObservedWebRequestDetails,
  tab: { tabId: number; windowId: number },
  frame: WebRequestFrameFields
): ChromeWebRequestDetails {
  const type = chromeResourceType(details.resourceType)
  return {
    requestId: String(details.id),
    url: details.url,
    method: details.method,
    ...frame,
    ...tab,
    type,
    timeStamp: details.timestamp,
    ...(details.requestHeaders
      ? { requestHeaders: requestHeaderList(details.requestHeaders) }
      : {}),
    ...(details.responseHeaders
      ? { responseHeaders: responseHeaderList(details.responseHeaders) }
      : {}),
    ...(details.statusCode !== undefined ? { statusCode: details.statusCode } : {}),
    ...(details.statusLine !== undefined ? { statusLine: details.statusLine } : {}),
    ...(details.fromCache !== undefined ? { fromCache: details.fromCache } : {}),
    ...(details.ip ? { ip: details.ip } : {}),
    ...(details.redirectURL ? { redirectUrl: details.redirectURL } : {}),
    ...(details.error ? { error: details.error } : {})
  }
}

/** Main-side pre-filter against one listener's chrome.webRequest.RequestFilter. */
export function webRequestFilterMatches(
  filter: unknown,
  details: ChromeWebRequestDetails
): boolean {
  if (filter === null || typeof filter !== 'object') {
    return true
  }
  const fields = new Map(Object.entries(filter))
  const urls = fields.get('urls')
  if (
    Array.isArray(urls) &&
    !urls.some(
      (pattern) => typeof pattern === 'string' && matchesExtensionMatchPattern(pattern, details.url)
    )
  ) {
    return false
  }
  const types = fields.get('types')
  if (Array.isArray(types) && !types.includes(details.type)) {
    return false
  }
  const tabId = fields.get('tabId')
  const windowId = fields.get('windowId')
  return (
    (typeof tabId !== 'number' || tabId === details.tabId) &&
    (typeof windowId !== 'number' || windowId === details.windowId)
  )
}

function isWebUrl(url: string): boolean {
  return /^(https?|wss?):/i.test(url)
}

function forward(
  session: Electron.Session,
  event: ObservedWebRequestEvent,
  details: ObservedWebRequestDetails
): void {
  if (
    !isWebUrl(details.url) ||
    !getBrowserExtensionProfileIdForSession(session) ||
    !browserExtensionEventHasListener(session, 'webRequest', event)
  ) {
    return
  }
  const entry =
    details.webContentsId === undefined ? null : resolveBrowserExtensionTab(details.webContentsId)
  const chromeDetails = toChromeWebRequestDetails(
    details,
    entry ? { tabId: entry.contents.id, windowId: entry.windowId } : { tabId: -1, windowId: -1 },
    frameFields(details)
  )
  emitBrowserExtensionEvent(
    { session },
    'webRequest',
    event,
    (extension) =>
      hasBrowserExtensionHostPermission(
        browserExtensionHostPatternsInSession(extension, session),
        details.url
      )
        ? [chromeDetails]
        : null,
    (filter) => webRequestFilterMatches(filter, chromeDetails)
  )
}

const observedSessions = new WeakSet<Electron.Session>()
const OBSERVE_ALL = { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }

/** The events Orca does not otherwise handle, installed once a webRequest extension loads. */
function observeRemainingEvents(session: Electron.Session): void {
  if (observedSessions.has(session)) {
    return
  }
  observedSessions.add(session)
  const { webRequest } = session
  webRequest.onSendHeaders(OBSERVE_ALL, (details) => forward(session, 'onSendHeaders', details))
  installBrowserSessionHeadersReceived(session)
  webRequest.onResponseStarted(OBSERVE_ALL, (details) =>
    forward(session, 'onResponseStarted', details)
  )
  webRequest.onBeforeRedirect(OBSERVE_ALL, (details) =>
    forward(session, 'onBeforeRedirect', details)
  )
  webRequest.onCompleted(OBSERVE_ALL, (details) => forward(session, 'onCompleted', details))
  webRequest.onErrorOccurred(OBSERVE_ALL, (details) => forward(session, 'onErrorOccurred', details))
}

export function observeBrowserExtensionWebRequests(session: Electron.Session): void {
  const maybeObserve = (extension: Electron.Extension): void => {
    if (extensionHasPermission(extension, 'webRequest', session)) {
      observeRemainingEvents(session)
    }
  }
  session.extensions.on('extension-ready', (_event, extension) => maybeObserve(extension))
  session.extensions.getAllExtensions().forEach(maybeObserve)
}

export function installBrowserExtensionWebRequestForwarding(): void {
  setBrowserSessionWebRequestObserver(forward)
}
