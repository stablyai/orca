import type { Session } from 'electron'

import {
  currentUserAgent,
  googleAuthUserAgent,
  isGoogleAuthUrl,
  setUserAgentHeader,
  stripClientHints
} from './browser-google-auth-ua'

// Why: Electron's default UA includes "Electron/X.X.X" and the app name
// (e.g. "orca/1.2.3"), an impossible identity for sessions imported from Chrome.
// This focused revocation fix strips only those tokens; it does not attempt full Chrome
// impersonation, and Chromium's client-hint identity remains browser-owned.
export function cleanElectronUserAgent(ua: string): string {
  return (
    ua
      .replace(/\s+Electron\/\S+/, '')
      // Why: \S+ matches any non-whitespace token (e.g. "orca/1.3.8-rc.0")
      // including pre-release semver strings that [\d.]+ would miss.
      .replace(/(\)\s+)\S+\s+(Chrome\/)/, '$1$2')
  )
}

export type BrowserSessionRequestUserAgentResolver = (args: {
  url: string
  webContentsId?: number
  currentUserAgent?: string
  effectiveUserAgent?: string
  baseUserAgent: string
}) => string | undefined

// Why: Chromium already publishes one internally consistent client-hint identity through both
// request headers and navigator.userAgentData. This handler owns the legacy User-Agent header on
// the wire; synthesizing Chrome brands here would make those browser-owned surfaces disagree.
export function setupGoogleAuthUserAgentOverride(
  sess: Session,
  resolveRequestUserAgent?: BrowserSessionRequestUserAgentResolver
): void {
  const firefoxUa = googleAuthUserAgent()

  sess.webRequest.onBeforeSendHeaders({ urls: ['https://*/*'] }, (details, callback) => {
    const headers = details.requestHeaders
    const requestUserAgent = currentUserAgent(headers)
    let effectiveUserAgent: string | undefined
    try {
      effectiveUserAgent = details.webContents?.getUserAgent()
    } catch {
      // The request can race guest teardown; the header and manager state still provide a fallback.
    }
    // The resolver is supplied by the browser manager so this layer can enforce viewport and
    // auth identities without importing manager state into the session policy (which would cycle).
    const baseUserAgent =
      typeof sess.getUserAgent === 'function'
        ? cleanElectronUserAgent(sess.getUserAgent())
        : (requestUserAgent ?? '')
    if (isGoogleAuthUrl(details.url)) {
      // Why: present a Firefox identity on Google's sign-in hosts so the user logs
      // in inside the app and Google issues self-refreshing bound cookies. Strip
      // sec-ch-ua* because real Firefox sends none.
      setUserAgentHeader(headers, firefoxUa)
      stripClientHints(headers)
      callback({ requestHeaders: headers })
      return
    }
    const userAgent =
      // Requests from an auth document fan out to gstatic and other non-auth hosts. Preserve the
      // Firefox identity already placed on those requests instead of switching them to Chrome.
      requestUserAgent === firefoxUa
        ? firefoxUa
        : resolveRequestUserAgent
          ? (resolveRequestUserAgent({
              url: details.url,
              webContentsId: details.webContentsId,
              currentUserAgent: requestUserAgent,
              effectiveUserAgent,
              baseUserAgent
            }) ??
            (baseUserAgent || requestUserAgent))
          : effectiveUserAgent === firefoxUa
            ? firefoxUa
            : baseUserAgent || requestUserAgent
    if (userAgent) {
      setUserAgentHeader(headers, userAgent)
    }
    if (userAgent === firefoxUa) {
      // Why: while the auth document is on screen the WebContents UA is Firefox,
      // so its cross-host subresource/XHR requests (gstatic, play.google.com, the
      // sign-in challenge endpoints) reach here carrying the Firefox UA yet still
      // bearing Chromium client hints. Rewriting those to Chrome pairs a Firefox
      // UA with Chrome hints — a sharper cross-host identity tell than either
      // alone, which can stall Google's password-submit challenge. Real Firefox
      // sends no client hints, so strip them to keep one identity for the flow.
      stripClientHints(headers)
      callback({ requestHeaders: headers })
      return
    }
    callback({ requestHeaders: headers })
  })
}
