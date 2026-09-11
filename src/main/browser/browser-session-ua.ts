import type { Session } from 'electron'

import {
  currentUserAgent,
  googleAuthUserAgent,
  setUserAgentHeader,
  shouldUseGoogleAuthIdentity,
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

// Why: Chromium already publishes one internally consistent client-hint identity through both
// request headers and navigator.userAgentData. This handler only owns the host-scoped Firefox
// exception; synthesizing Chrome brands here would make those two browser-owned surfaces disagree.
export function setupGoogleAuthUserAgentOverride(sess: Session): void {
  const firefoxUa = googleAuthUserAgent()

  sess.webRequest.onBeforeSendHeaders({ urls: ['https://*/*'] }, (details, callback) => {
    const headers = details.requestHeaders
    if (shouldUseGoogleAuthIdentity(details.url, details.referrer, details.resourceType)) {
      // Why: present a Firefox identity on Google's sign-in hosts so the user logs
      // in inside the app and Google issues self-refreshing bound cookies. Auth-page
      // subresources share that identity even before the WebContents override lands.
      setUserAgentHeader(headers, firefoxUa)
      stripClientHints(headers)
      callback({ requestHeaders: headers })
      return
    }
    if (currentUserAgent(headers) === firefoxUa) {
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
