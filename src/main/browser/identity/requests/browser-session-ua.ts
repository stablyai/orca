import type { Session } from 'electron'
import type { BrowserTabIdentity } from '../browser-tab-identity'
import { getBrowserProcessUserAgentIdentity } from '../browser-process-user-agent'
import { decideBrowserSessionRequestHeaders } from '../../sessions/requests/browser-session-request-decisions'
import { reportBrowserSessionWebRequest } from '../../sessions/requests/browser-session-web-request-observer'
import {
  currentUserAgent,
  setUserAgentHeader,
  stripClientHints,
  applyUserAgentMetadataHeaders
} from './browser-user-agent-request-headers'
import { googleAuthUserAgent, shouldUseGoogleAuthIdentity } from '../browser-google-auth-ua'

export type BrowserSessionRequestUserAgentResolver = (args: {
  session: Session
  url: string
  referrer?: string
  resourceType?: string
  webContentsId?: number
  currentUserAgent?: string
  effectiveUserAgent?: string
}) => BrowserTabIdentity | undefined

// Rewrite only hints Chromium emitted; desktop hints remain browser-owned.
export function installBrowserSessionUserAgentPolicy(
  sess: Session,
  resolveRequestUserAgent?: BrowserSessionRequestUserAgentResolver
): () => void {
  const googleAuthUa = googleAuthUserAgent()
  const processUa = getBrowserProcessUserAgentIdentity().userAgent
  const applyUserAgentPolicy = (details: Electron.OnBeforeSendHeadersListenerDetails): void => {
    const headers = details.requestHeaders
    const requestUserAgent = currentUserAgent(headers)
    let effectiveUserAgent: string | undefined
    try {
      effectiveUserAgent = details.webContents?.getUserAgent()
    } catch {
      // The request can race guest teardown; the header and manager state still provide a fallback.
    }
    if (
      shouldUseGoogleAuthIdentity(details.url, details.referrer ?? '', details.resourceType ?? '')
    ) {
      // Chromium's own hints match the Electron UA; hints under any other UA came from an override.
      if (requestUserAgent !== googleAuthUa && requestUserAgent !== processUa) {
        stripClientHints(headers)
      }
      setUserAgentHeader(headers, googleAuthUa)
      return
    }
    const identity = resolveRequestUserAgent?.({
      session: sess,
      url: details.url,
      referrer: details.referrer,
      resourceType: details.resourceType,
      webContentsId: details.webContentsId,
      currentUserAgent: requestUserAgent,
      effectiveUserAgent
    })
    if (!identity) {
      return
    }
    setUserAgentHeader(headers, identity.userAgent)
    if (identity.kind === 'mobile') {
      applyUserAgentMetadataHeaders(headers, identity.userAgentMetadata)
    }
  }
  sess.webRequest.onBeforeSendHeaders(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback) => {
      reportBrowserSessionWebRequest(sess, 'onBeforeSendHeaders', details)
      applyUserAgentPolicy(details)
      // Why after the policy: Chrome sets its own user agent before extensions modify headers.
      callback({
        requestHeaders: decideBrowserSessionRequestHeaders(sess, details, details.requestHeaders)
      })
    }
  )
  let disposed = false
  return (): void => {
    if (disposed) {
      return
    }
    disposed = true
    sess.webRequest.onBeforeSendHeaders(null)
  }
}
