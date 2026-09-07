import type { Session } from 'electron'

import {
  currentUserAgent,
  googleAuthUserAgent,
  isGoogleAuthUrl,
  setUserAgentHeader,
  stripClientHints
} from './browser-google-auth-ua'

// Why: the session keeps Electron's stock UA. Stripping the Electron/app tokens to look like
// plain Chrome is what Cloudflare Turnstile rejects (error 600010): a Chrome UA that ships no
// client hints reads as a spoof, while a declared Electron client clears the same challenge.
// This handler only owns the Google auth-host Firefox switch, which is a proven, host-scoped
// exception that must stay consistent across the header and every cross-host subresource.
export function setupGoogleAuthUserAgentOverride(sess: Session): void {
  const firefoxUa = googleAuthUserAgent()

  sess.webRequest.onBeforeSendHeaders({ urls: ['https://*/*'] }, (details, callback) => {
    const headers = details.requestHeaders
    if (isGoogleAuthUrl(details.url)) {
      // Why: present a Firefox identity on Google's sign-in hosts so the user logs
      // in inside the app and Google issues self-refreshing bound cookies. Strip
      // sec-ch-ua* because real Firefox sends none.
      setUserAgentHeader(headers, firefoxUa)
      stripClientHints(headers)
    } else if (currentUserAgent(headers) === firefoxUa) {
      // Why: while the auth document is on screen the WebContents UA is Firefox, so its
      // cross-host subresource/XHR requests carry the Firefox UA yet still bear Chromium
      // client hints — a sharper cross-host identity tell than either alone.
      stripClientHints(headers)
    }
    callback({ requestHeaders: headers })
  })
}
