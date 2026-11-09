import { chromeResourceType } from './browser-extension-request-classification'
import type { ObservedWebRequestDetails } from '../../sessions/requests/browser-session-web-request-observer'
import { chromeFrameDocument } from '../tabs-and-windows/browser-extension-frame-projection'

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
export function browserExtensionRequestFrameFields(
  details: ObservedWebRequestDetails
): WebRequestFrameFields {
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
