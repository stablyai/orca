import type { Session } from 'electron'
import type { ViewportUserAgentOverride } from './browser-viewport-user-agent'
export { cleanElectronUserAgent } from './browser-process-user-agent'
import { getBrowserProcessUserAgentIdentity } from './browser-process-user-agent'

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
// so worker requests replace only hints Chromium already chose to emit without inventing them.
export function installBrowserSessionUserAgentPolicy(
  sess: Session,
  resolveRequestUserAgent?: BrowserSessionRequestUserAgentResolver
): () => void {
  const firefoxUa = googleAuthUserAgent()
  sess.webRequest.onBeforeSendHeaders(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback) => {
      const headers = details.requestHeaders
      const requestUserAgent = currentUserAgent(headers)
      let effectiveUserAgent: string | undefined
      try {
        effectiveUserAgent = details.webContents?.getUserAgent()
      } catch {
        // The request can race guest teardown; the header and manager state still provide a fallback.
      }
      // Firefox is delivered per-target and cannot reach workers; keep it clean-only to preserve one
      // coherent identity per mode instead of pairing a Firefox document with native workers.
      if (
        getBrowserProcessUserAgentIdentity().mode === 'clean' &&
        shouldUseGoogleAuthIdentity(details.url, details.referrer ?? '', details.resourceType ?? '')
      ) {
        setUserAgentHeader(headers, firefoxUa)
        stripClientHints(headers)
        callback({ requestHeaders: headers })
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
        callback({ requestHeaders: headers })
        return
      }
      if (identity.userAgent) {
        setUserAgentHeader(headers, identity.userAgent)
      }
      if (identity.userAgent === firefoxUa) {
        stripClientHints(headers)
        callback({ requestHeaders: headers })
        return
      }
      if (identity.userAgentMetadata) {
        applyUserAgentMetadataHeaders(headers, identity.userAgentMetadata)
      }
      callback({ requestHeaders: headers })
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
