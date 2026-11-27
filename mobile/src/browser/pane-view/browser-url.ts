import { ORCA_BROWSER_BLANK_URL } from '../../../../src/shared/browser/browser-blank-page'
import {
  DEFAULT_SEARCH_ENGINE,
  normalizeBrowserNavigationUrl
} from '../../../../src/shared/browser/navigation/browser-url'

/** Desktop's address-bar rule; the phone has no search engine setting, so it uses desktop's default. */
export function normalizeBrowserUrl(value: string): string | null {
  const url = normalizeBrowserNavigationUrl(value, DEFAULT_SEARCH_ENGINE)
  // Keep sending the blank address the phone always sent, which every host accepts.
  return url === ORCA_BROWSER_BLANK_URL ? 'about:blank' : url
}

export function displayBrowserUrl(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? ''
  return isBlankBrowserUrl(trimmed) ? 'about:blank' : trimmed
}

export function compactMobileBrowserFileAddress(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'file:') {
      return null
    }
    const segments = url.pathname.split('/').filter(Boolean)
    const encodedFilename = segments.at(-1)
    if (!encodedFilename) {
      return 'file:'
    }
    try {
      return `file: …/${decodeURIComponent(encodedFilename)}`
    } catch {
      return `file: …/${encodedFilename}`
    }
  } catch {
    return null
  }
}

export function isBlankBrowserUrl(value: string | null | undefined): boolean {
  const trimmed = value?.trim() ?? ''
  return !trimmed || trimmed === 'about:blank' || trimmed.startsWith('data:text/html')
}

/** What the bottom bar's pill shows while reading: the site alone, as Safari does. Null for a blank page. */
export function mobileBrowserAddressLabel(
  value: string
): { text: string; secure: boolean; file: boolean } | null {
  if (isBlankBrowserUrl(value)) {
    return null
  }
  const file = compactMobileBrowserFileAddress(value)
  if (file) {
    return { text: file, secure: false, file: true }
  }
  try {
    const url = new URL(value)
    if (url.host) {
      return {
        text: url.host.replace(/^www\./, ''),
        secure: url.protocol === 'https:',
        file: false
      }
    }
  } catch {
    // Not a URL the phone can parse; show it as the host sent it.
  }
  return { text: value, secure: false, file: false }
}
