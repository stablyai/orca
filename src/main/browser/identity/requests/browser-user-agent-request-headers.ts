import type { UserAgentMetadata } from '../browser-tab-identity'

export function stripClientHints(headers: Record<string, string>): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase().startsWith('sec-ch-ua')) {
      delete headers[key]
    }
  }
}

// Replace case-insensitively to avoid duplicate User-Agent headers.
export function setUserAgentHeader(headers: Record<string, string>, value: string): void {
  const existing = Object.keys(headers).find((key) => key.toLowerCase() === 'user-agent')
  headers[existing ?? 'User-Agent'] = value
}

// The outgoing UA identifies auth-document requests even across hosts.
export function currentUserAgent(headers: Record<string, string>): string | undefined {
  const existing = Object.keys(headers).find((key) => key.toLowerCase() === 'user-agent')
  return existing ? headers[existing] : undefined
}

function quoteClientHint(value: string): string {
  return `"${value.replace(/["\\]/g, '\\$&')}"`
}

function formatClientHintBrands(brands: { brand: string; version: string }[]): string {
  return brands
    .map(({ brand, version }) => `${quoteClientHint(brand)};v=${quoteClientHint(version)}`)
    .join(', ')
}

export function applyUserAgentMetadataHeaders(
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
