import { webRequestFilterMatches } from './browser-extension-web-request-filter'
import {
  browserExtensionRequestFrameFields,
  toChromeWebRequestDetails
} from './browser-extension-web-request-details'
import { isRequestHiddenFromExtensions } from './browser-extension-request-classification'
import {
  installBrowserSessionHeadersReceived,
  installBrowserSessionRequestLifecycle,
  removeBrowserSessionHeadersReceived,
  removeBrowserSessionRequestLifecycle
} from '../../sessions/requests/browser-session-request-decisions'
import {
  setBrowserSessionWebRequestObserver,
  type ObservedWebRequestDetails,
  type ObservedWebRequestEvent
} from '../../sessions/requests/browser-session-web-request-observer'
import { browserExtensionHostPatternsInSession } from '../permissions/browser-extension-session-permissions'
import {
  emitBrowserExtensionEvent,
  getBrowserExtensionProfileIdForSession
} from '../api-runtime/browser-extension-api-host'
import { browserExtensionEventHasListener } from '../api-runtime/browser-extension-contexts'
import { extensionHasPermission } from '../api-runtime/browser-extension-namespace-registry'
import { hasBrowserExtensionHostPermission } from '../permissions/browser-extension-permission-grants'
import { canExtensionAccessRequest } from '../permissions/browser-extension-request-host-access'
import { resolveBrowserExtensionTab } from '../tabs-and-windows/browser-extension-tab-model'

/**
 * chrome.webRequest, observed rather than blocking. Electron 43 delivers no webRequest events to
 * MV3 workers, and Orca's own session handlers switch Electron's extension webRequest off anyway,
 * so Orca forwards what its handlers see. MV3 store extensions cannot block requests in Chrome
 * either (webRequestBlocking is policy-only), so nothing they could do is lost.
 */

function forward(
  session: Electron.Session,
  event: ObservedWebRequestEvent,
  details: ObservedWebRequestDetails
): void {
  if (
    isRequestHiddenFromExtensions(details) ||
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
    browserExtensionRequestFrameFields(details)
  )
  const request = {
    url: details.url,
    initiator: details.initiatorOrigin ?? null,
    tabId: chromeDetails.tabId,
    type: chromeDetails.type
  }
  emitBrowserExtensionEvent(
    { session },
    'webRequest',
    event,
    (extension) => {
      const patterns = browserExtensionHostPatternsInSession(extension, session)
      return canExtensionAccessRequest(extension.id, request, (url) =>
        hasBrowserExtensionHostPermission(patterns, url)
      )
        ? [chromeDetails]
        : null
    },
    (filter) => webRequestFilterMatches(filter, chromeDetails)
  )
}

const observedSessions = new WeakSet<Electron.Session>()
const watchedSessions = new WeakSet<Electron.Session>()
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
  installBrowserSessionRequestLifecycle(session)
}

export function observeBrowserExtensionWebRequests(session: Electron.Session): void {
  const maybeObserve = (extension: Electron.Extension): void => {
    if (extensionHasPermission(extension, 'webRequest', session)) {
      observeRemainingEvents(session)
    }
  }
  if (!watchedSessions.has(session)) {
    watchedSessions.add(session)
    session.extensions.on('extension-ready', (_event, extension) => maybeObserve(extension))
  }
  session.extensions.getAllExtensions().forEach(maybeObserve)
}

/** Extensions turned off: hand the session's request path back to Orca's own handlers alone. */
export function stopObservingBrowserExtensionWebRequests(session: Electron.Session): void {
  removeBrowserSessionHeadersReceived(session)
  removeBrowserSessionRequestLifecycle(session)
  if (!observedSessions.delete(session)) {
    return
  }
  const { webRequest } = session
  webRequest.onSendHeaders(null)
  webRequest.onResponseStarted(null)
  webRequest.onBeforeRedirect(null)
}

export function installBrowserExtensionWebRequestForwarding(): void {
  setBrowserSessionWebRequestObserver(forward)
}
