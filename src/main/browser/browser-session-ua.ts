import type { Session } from 'electron'

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

// Why: Electron's actual Chromium version (e.g. 134) differs from the source
// browser's version (e.g. Edge 147). The sec-ch-ua Client Hints headers
// reveal the real version, creating a mismatch that Google's anti-fraud
// detection flags as CookieMismatch on accounts.google.com. Override Client
// Hints on outgoing requests to match the source browser's UA.
export function setupClientHintsOverride(sess: Session, ua: string): void {
  const chromeMatch = ua.match(/Chrome\/([\d.]+)/)
  if (!chromeMatch) {
    return
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

  const secChUa = `"${brand}";v="${brandMajor}", "Chromium";v="${majorVersion}", "Not/A)Brand";v="24"`
  const secChUaFull = `"${brand}";v="${brandFullVersion}", "Chromium";v="${fullChromeVersion}", "Not/A)Brand";v="24.0.0.0"`

  sess.webRequest.onBeforeSendHeaders({ urls: ['https://*/*'] }, (details, callback) => {
    const headers = details.requestHeaders
    for (const key of Object.keys(headers)) {
      const lower = key.toLowerCase()
      if (lower === 'sec-ch-ua') {
        headers[key] = secChUa
      } else if (lower === 'sec-ch-ua-full-version-list') {
        headers[key] = secChUaFull
      }
    }
    callback({ requestHeaders: headers })
  })
}
