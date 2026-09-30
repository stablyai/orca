/**
 * Bitbucket Data Center (Server) deployment settings.
 *
 * Data Center is reached at an arbitrary host that may sit under a context
 * path (`https://host/bitbucket`), so — unlike Bitbucket Cloud — the base URL
 * is part of the user's configuration rather than a constant.
 */
export type BitbucketServerConfig = {
  /** Site base URL including any context path, without a trailing slash. */
  baseUrl: string | null
  /** Lowercased hostname of `baseUrl`, used to claim matching git remotes. */
  host: string | null
  /** HTTP access token (PAT) sent as a bearer token. */
  token: string | null
}

function envValue(name: string): string | null {
  const value = process.env[name]?.trim() ?? ''
  return value.length > 0 ? value : null
}

/**
 * Accepts a bare host, a site URL, or a pasted REST URL, and returns the site
 * base every Data Center URL is built from.
 */
function normalizeBitbucketServerBaseUrl(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
    const path = url.pathname.replace(/\/+$/, '').replace(/\/rest(?:\/api\/(?:1\.0|latest))?$/i, '')
    return `${url.origin}${path}`
  } catch {
    return null
  }
}

export function getBitbucketServerConfig(): BitbucketServerConfig {
  const rawBaseUrl = envValue('ORCA_BITBUCKET_SERVER_URL')
  const baseUrl = rawBaseUrl ? normalizeBitbucketServerBaseUrl(rawBaseUrl) : null
  let host: string | null = null
  if (baseUrl) {
    try {
      host = new URL(baseUrl).hostname.toLowerCase()
    } catch {
      host = null
    }
  }
  return { baseUrl, host, token: envValue('ORCA_BITBUCKET_SERVER_TOKEN') }
}
