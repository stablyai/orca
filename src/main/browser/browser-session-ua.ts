import type { Session } from 'electron'
import type { BrowserTabIdentity, UserAgentMetadata } from './browser-tab-identity'
export { cleanElectronUserAgent } from './browser-process-user-agent'
import { getBrowserProcessUserAgentIdentity } from './browser-process-user-agent'
import { decideBrowserSessionRequestHeaders } from './browser-session-request-decisions'
import { reportBrowserSessionWebRequest } from './browser-session-web-request-observer'

import {
  currentUserAgent,
  googleAuthUserAgent,
  setUserAgentHeader,
  shouldUseGoogleAuthIdentity,
  stripClientHints
} from './browser-google-auth-ua'

export type BrowserSessionRequestUserAgentResolver = (args: {
  session: Session
  url: string
  referrer?: string
  resourceType?: string
  webContentsId?: number
  currentUserAgent?: string
  effectiveUserAgent?: string
}) => BrowserTabIdentity | undefined

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
  metadata: UserAgentMetadata
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
