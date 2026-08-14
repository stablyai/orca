import type { Session } from 'electron'

import {
  currentUserAgent,
  googleAuthUserAgent,
  isGoogleAuthUrl,
  setUserAgentHeader,
  stripClientHints
} from './browser-google-auth-ua'

// Why: Electron's default UA includes "Electron/X.X.X" and the app name
// (e.g. "orca/1.2.3"), which Cloudflare Turnstile and other bot detectors
// flag as non-human traffic. Strip those tokens so the webview's UA and
// sec-ch-ua Client Hints look like standard Chrome.
export function cleanElectronUserAgent(ua: string): string {
  return (
    ua
      .replace(/\s+Electron\/\S+/, '')
      // Why: \S+ matches any non-whitespace token (e.g. "orca/1.3.8-rc.0")
      // including pre-release semver strings that [\d.]+ would miss.
      .replace(/(\)\s+)\S+\s+(Chrome\/)/, '$1$2')
  )
}

// Why: Electron emits sec-ch-ua brands like "Not A(Brand" without a
// "Google Chrome" entry, which disagrees with the Chrome-shaped UA the session
// presents. Rewrite the hint headers to the brand set Chrome ships for the same
// engine version so the two surfaces tell one story. Also owns the Google
// auth-host Firefox switch, which must install even for a non-Chrome-shaped UA.
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
