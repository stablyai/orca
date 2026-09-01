import type { Session } from 'electron'

import {
  currentUserAgent,
  googleAuthUserAgent,
  isGoogleAuthUrl,
  setUserAgentHeader,
  stripClientHints
} from './browser-google-auth-ua'

// Why the session UA is left alone (STA-3905): stripping "Electron/X" and the app name leaves a UA
// claiming Google Chrome, and Chromium under Electron sends no sec-ch-ua* client hints at all — a
// combination no real Chrome produces. Cloudflare's managed challenge rejects it ("There was a
// problem with verification"), while the untouched engine UA passes. Measured on
// dash.cloudflare.com/login: untouched 5/5 pass, every rewritten variant 12/12 fail.
//
// The brand rewrite below is kept for hosts that do send the hints, but its real job now is the
// Google auth-host Firefox switch, which must install regardless of the UA shape.
export function setupClientHintsOverride(
  sess: Session,
  ua: string,
  options: { googleAuthOverride?: boolean } = {}
): void {
  // Why: only Chrome-shaped base UAs carry sec-ch-ua hints to rewrite, but the
  // Google-auth Firefox switch below must install regardless, so keep the hints
  // optional rather than bailing out of the whole handler.
  const chromeHints = buildChromeClientHints(ua)
  const firefoxUa = googleAuthUserAgent()

  sess.webRequest.onBeforeSendHeaders({ urls: ['https://*/*'] }, (details, callback) => {
    const headers = details.requestHeaders
    if (options.googleAuthOverride !== false && isGoogleAuthUrl(details.url)) {
      // Why: present a Firefox identity on Google's sign-in hosts so the user logs
      // in inside the app and Google issues self-refreshing bound cookies. Strip
      // sec-ch-ua* because real Firefox sends none.
      setUserAgentHeader(headers, firefoxUa)
      stripClientHints(headers)
      callback({ requestHeaders: headers })
      return
    }
    if (options.googleAuthOverride !== false && currentUserAgent(headers) === firefoxUa) {
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
    if (chromeHints) {
      for (const key of Object.keys(headers)) {
        const lower = key.toLowerCase()
        if (lower === 'sec-ch-ua') {
          headers[key] = chromeHints.secChUa
        } else if (lower === 'sec-ch-ua-full-version-list') {
          headers[key] = chromeHints.secChUaFull
        }
      }
    }
    callback({ requestHeaders: headers })
  })
}

function buildChromeClientHints(ua: string): { secChUa: string; secChUaFull: string } | null {
  const chromeMatch = ua.match(/Chrome\/([\d.]+)/)
  if (!chromeMatch) {
    return null
  }
  const fullChromeVersion = chromeMatch[1]
  const majorVersion = fullChromeVersion.split('.')[0]

  let brand = 'Google Chrome'
  let brandFullVersion = fullChromeVersion

  const edgeMatch = ua.match(/Edg\/([\d.]+)/)
  if (edgeMatch) {
    brand = 'Microsoft Edge'
    brandFullVersion = edgeMatch[1]
  }
  const brandMajor = brandFullVersion.split('.')[0]

  return {
    secChUa: `"${brand}";v="${brandMajor}", "Chromium";v="${majorVersion}", "Not/A)Brand";v="24"`,
    secChUaFull: `"${brand}";v="${brandFullVersion}", "Chromium";v="${fullChromeVersion}", "Not/A)Brand";v="24.0.0.0"`
  }
}
