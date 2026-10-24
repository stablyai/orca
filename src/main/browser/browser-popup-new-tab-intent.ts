// Keep named and OAuth popups attached to their opener; tab conversion returns null to the page.
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

// Reopening by URL drops the opener and POST body.
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
