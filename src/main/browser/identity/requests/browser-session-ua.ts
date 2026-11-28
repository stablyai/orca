import type { Session } from 'electron'
import type { BrowserTabIdentity } from '../browser-tab-identity'
import { getBrowserProcessUserAgentIdentity } from '../browser-process-user-agent'
import { decideBrowserSessionRequestHeaders } from '../../sessions/requests/browser-session-request-decisions'
import { reportBrowserSessionWebRequest } from '../../sessions/requests/browser-session-web-request-observer'
import { holdBrowserSessionWebRequest } from '../../sessions/requests/browser-session-web-request-owner'
import {
  hasBrowserSessionUserAgentDemand,
  watchBrowserSessionUserAgentDemand
} from './browser-session-ua-demand'
import {
  currentUserAgent,
  setUserAgentHeader,
  stripClientHints,
  applyUserAgentMetadataHeaders
} from './browser-user-agent-request-headers'
import {
  googleAuthUserAgent,
  shouldUseGoogleAuthIdentity,
  teamsRequestUserAgent
} from '../browser-site-user-agent'

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
/** Clean mode and extensions keep the header listener installed whatever tabs demand. */
export function browserSessionHeaderListenerIgnoresDemand(sess: Session): boolean {
  return (
    getBrowserProcessUserAgentIdentity().mode === 'clean' ||
    (sess.extensions?.getAllExtensions().length ?? 0) > 0
  )
}

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
    if (identity) {
      setUserAgentHeader(headers, identity.userAgent)
      if (identity.kind === 'mobile') {
        applyUserAgentMetadataHeaders(headers, identity.userAgentMetadata)
      }
    }
    const outgoingUserAgent = currentUserAgent(headers)
    if (outgoingUserAgent) {
      setUserAgentHeader(headers, teamsRequestUserAgent(details.url, outgoingUserAgent))
    }
  }
  const listen = (): (() => void) =>
    holdBrowserSessionWebRequest(
      sess,
      'onBeforeSendHeaders',
      (details, callback) => {
        reportBrowserSessionWebRequest(sess, 'onBeforeSendHeaders', details)
        applyUserAgentPolicy(details)
        // Why after the policy: Chrome sets its own user agent before extensions modify headers.
        callback({
          requestHeaders: decideBrowserSessionRequestHeaders(sess, details, details.requestHeaders)
        })
      },
      { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }
    )
  // Any listener makes every request wait on main, so listen only while a header can change:
  // clean mode (Google sign-in restores Electron's UA), extensions, or a tab whose identity differs.
  let release: (() => void) | null = null
  const refresh = (): void => {
    const needed =
      browserSessionHeaderListenerIgnoresDemand(sess) || hasBrowserSessionUserAgentDemand(sess)
    if (needed && !release) {
      release = listen()
    } else if (!needed && release) {
      release()
      release = null
    }
  }
  const stopDemand = watchBrowserSessionUserAgentDemand(sess, refresh)
  sess.extensions?.on('extension-loaded', refresh)
  sess.extensions?.on('extension-unloaded', refresh)
  refresh()
  return () => {
    stopDemand()
    sess.extensions?.off('extension-loaded', refresh)
    sess.extensions?.off('extension-unloaded', refresh)
    release?.()
    release = null
  }
}
