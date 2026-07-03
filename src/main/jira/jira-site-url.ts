const PROTOCOL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i
const HTTP_PROTOCOL_PATTERN = /^https?:\/\//i

function stripJiraUrlMetadata(url: URL): void {
  // Why: auth secrets belong in encrypted credential storage, never site
  // metadata, UI labels, or request routing keys.
  url.username = ''
  url.password = ''
  url.pathname = url.pathname.replace(/\/+$/, '')
  url.search = ''
  url.hash = ''
}

export function normalizeJiraSiteUrl(siteUrl: string): string {
  const trimmed = siteUrl.trim()
  if (PROTOCOL_PATTERN.test(trimmed) && !HTTP_PROTOCOL_PATTERN.test(trimmed)) {
    throw new Error('Jira site URL must use HTTP or HTTPS.')
  }
  const withProtocol = HTTP_PROTOCOL_PATTERN.test(trimmed) ? trimmed : `https://${trimmed}`
  const url = new URL(withProtocol)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Jira site URL must use HTTP or HTTPS.')
  }
  stripJiraUrlMetadata(url)
  return url.toString().replace(/\/$/, '')
}

export function normalizeStoredJiraSiteUrl(siteUrl: string): string | null {
  const trimmed = siteUrl.trim()
  if (!trimmed) {
    return null
  }
  try {
    return normalizeJiraSiteUrl(trimmed)
  } catch {
    return null
  }
}
