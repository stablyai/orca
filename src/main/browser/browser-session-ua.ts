import type { Session } from 'electron'
import type { ViewportUserAgentOverride } from './browser-viewport-user-agent'

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

export type BrowserSessionRequestUserAgentResolver = (args: {
  session: Session
  url: string
  webContentsId?: number
  currentUserAgent?: string
  effectiveUserAgent?: string
  baseUserAgent: string
}) => ViewportUserAgentOverride | undefined

function quoteClientHint(value: string): string {
  return `"${value.replace(/["\\]/g, '\\$&')}"`
}

function formatClientHintBrands(brands: { brand: string; version: string }[]): string {
  return brands
    .map(({ brand, version }) => `${quoteClientHint(brand)};v=${quoteClientHint(version)}`)
    .join(', ')
}

function applyUserAgentMetadataHeaders(
  headers: Record<string, string>,
  metadata: NonNullable<ViewportUserAgentOverride['userAgentMetadata']>
): void {
  const values: Record<string, string> = {
    'sec-ch-ua': formatClientHintBrands(metadata.brands),
    'sec-ch-ua-full-version-list': formatClientHintBrands(metadata.fullVersionList),
    'sec-ch-ua-full-version': quoteClientHint(metadata.fullVersion),
    'sec-ch-ua-platform': quoteClientHint(metadata.platform),
    'sec-ch-ua-platform-version': quoteClientHint(metadata.platformVersion),
    'sec-ch-ua-arch': quoteClientHint(metadata.architecture),
    'sec-ch-ua-model': quoteClientHint(metadata.model),
    'sec-ch-ua-mobile': metadata.mobile ? '?1' : '?0'
  }
  for (const key of Object.keys(headers)) {
    const lowerKey = key.toLowerCase()
    if (!lowerKey.startsWith('sec-ch-ua')) {
      continue
    }
    const value = values[lowerKey]
    if (value === undefined) {
      delete headers[key]
    } else {
      headers[key] = value
    }
  }
}

// Desktop client hints remain browser-owned. Mobile overrides carry the same metadata CDP used,
// so worker requests can replace only hints Chromium already chose to emit without inventing them.
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
    if (shouldUseGoogleAuthIdentity(details.url, details.referrer, details.resourceType)) {
      // Why: present a Firefox identity on Google's sign-in hosts so the user logs
      // in inside the app and Google issues self-refreshing bound cookies. Auth-page
      // subresources share that identity even before the WebContents override lands.
      setUserAgentHeader(headers, firefoxUa)
      stripClientHints(headers)
      callback({ requestHeaders: headers })
      return
    }
    const identity =
      // Requests from an auth document fan out to gstatic and other non-auth hosts. Preserve the
      // Firefox identity already placed on those requests instead of switching them to Chrome.
      requestUserAgent === firefoxUa
        ? { userAgent: firefoxUa }
        : resolveRequestUserAgent
          ? (resolveRequestUserAgent({
              session: sess,
              url: details.url,
              webContentsId: details.webContentsId,
              currentUserAgent: requestUserAgent,
              effectiveUserAgent,
              baseUserAgent
            }) ?? { userAgent: baseUserAgent || requestUserAgent || '' })
          : effectiveUserAgent === firefoxUa
            ? { userAgent: firefoxUa }
            : { userAgent: baseUserAgent || requestUserAgent || '' }
    if (identity.userAgent) {
      setUserAgentHeader(headers, identity.userAgent)
    }
    if (identity.userAgent === firefoxUa) {
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
    if (identity.userAgentMetadata) {
      applyUserAgentMetadataHeaders(headers, identity.userAgentMetadata)
    }
    callback({ requestHeaders: headers })
  })
}
