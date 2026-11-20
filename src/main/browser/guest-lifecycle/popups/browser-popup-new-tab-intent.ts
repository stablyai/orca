export type NewBrowserTabPopupRequest = {
  url: string
  frameName: string
  disposition: string
  postBody?: Electron.PostBody | null
  features?: string
}

// Keep named and OAuth popups attached to their opener; tab conversion returns null to the page.
export function isNewBrowserTabPopupIntent(details: NewBrowserTabPopupRequest): boolean {
  return (
    isBrowserTabPopupRequest(details) &&
    !isBlankBrowserPopupUrl(details.url) &&
    !isOAuthAuthorizationUrl(details.url)
  )
}

// <a target="_blank"> and window.open(url, "_blank") arrive with the same details.
// Chromium sets webContents.opener only after the child exists.
export function isUndecidedWindowOpenerRequest(details: NewBrowserTabPopupRequest): boolean {
  return (
    details.disposition === 'foreground-tab' &&
    isNewBrowserTabPopupIntent(details) &&
    !windowFeaturesDropOpener(details.features ?? '')
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

function windowFeaturesDropOpener(features: string): boolean {
  for (const part of features.split(',')) {
    const [rawKey, rawValue] = part.split('=', 2)
    const key = rawKey?.trim().toLowerCase()
    if ((key === 'noopener' || key === 'noreferrer') && featureValueEnabled(rawValue)) {
      return true
    }
  }
  return false
}

// Chromium's window feature booleans: a bare token is true, and 0/no/false is false.
function featureValueEnabled(rawValue: string | undefined): boolean {
  if (rawValue === undefined) {
    return true
  }
  const value = rawValue.trim().toLowerCase()
  if (value === '' || value === 'yes' || value === 'true') {
    return true
  }
  if (value === 'no' || value === 'false') {
    return false
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed !== 0
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
