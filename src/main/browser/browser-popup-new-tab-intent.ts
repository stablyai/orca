/**
 * Whether a new-window request from a page should open an Orca tab rather than a popup window.
 *
 * Chromium's disposition already carries Chrome's answer: new-tab links, Cmd/Ctrl/middle clicks, and
 * `window.open` without window features (`noopener` and `noreferrer` are not features) arrive as a
 * tab, while size/position features and Shift-click arrive as `new-window`. Denying hands the page
 * `null`, so named opens and OAuth authorization URLs must keep their opener in a child window.
 */
export function isNewBrowserTabPopupIntent(details: {
  url: string
  frameName: string
  disposition: string
  postBody?: Electron.PostBody | null
}): boolean {
  return (
    isBrowserTabPopupRequest(details) &&
    !isBlankBrowserPopupUrl(details.url) &&
    !isOAuthAuthorizationUrl(details.url)
  )
}

/** A GET Chrome would open as a tab; Orca can only reopen its URL, which drops any opener. */
export function isBrowserTabPopupRequest(details: {
  frameName: string
  disposition: string
  postBody?: Electron.PostBody | null
}): boolean {
  return (
    details.frameName === '' &&
    (details.disposition === 'foreground-tab' || details.disposition === 'background-tab') &&
    !details.postBody
  )
}

export function isBlankBrowserPopupUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    return url.protocol === 'about:' && url.pathname === 'blank' && url.search === ''
  } catch {
    return false
  }
}

/** Popup destinations are Chromium URLs, never address-bar searches or local files. */
export function normalizeBrowserPopupUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== 'string') {
    return null
  }
  try {
    const url = new URL(rawUrl)
    return url.protocol === 'https:' || url.protocol === 'http:' || isBlankBrowserPopupUrl(rawUrl)
      ? url.href
      : null
  } catch {
    return null
  }
}

// Unnamed window.open(url), used by Deel, has the same disposition as an ordinary new-tab link.
function isOAuthAuthorizationUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return false
    }
    const params = url.searchParams
    if (!params.get('client_id')?.trim() || !params.get('redirect_uri')?.trim()) {
      return false
    }
    const responseTypes = params.get('response_type')?.trim().split(/\s+/) ?? []
    if (responseTypes.length === 1 && responseTypes[0] === 'none') {
      return true
    }
    return (
      responseTypes.length > 0 &&
      new Set(responseTypes).size === responseTypes.length &&
      responseTypes.every((type) => type === 'code' || type === 'token' || type === 'id_token')
    )
  } catch {
    return false
  }
}
