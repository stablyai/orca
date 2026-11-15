const MATCH_PATTERN = /^(\*|https?|wss?|file|ftp):\/\/(\*|\*\.[^/*]+|[^/*]+)?(\/.*)$/

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')
  return new RegExp(`^${escaped}$`)
}

/** Chrome match-pattern test (https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns). */
export function matchesExtensionMatchPattern(pattern: string, rawUrl: string): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  const scheme = url.protocol.slice(0, -1)
  if (pattern === '<all_urls>') {
    return ['http', 'https', 'ws', 'wss', 'file', 'ftp'].includes(scheme)
  }
  const match = MATCH_PATTERN.exec(pattern)
  if (!match) {
    return false
  }
  const [, patternScheme, patternHost = '', patternPath] = match
  const schemeMatches =
    patternScheme === '*'
      ? ['http', 'https', 'ws', 'wss'].includes(scheme)
      : patternScheme === scheme
  if (!schemeMatches) {
    return false
  }
  const host = url.hostname.toLowerCase()
  const wantedHost = patternHost.toLowerCase()
  const hostMatches =
    wantedHost === '*' ||
    (wantedHost.startsWith('*.')
      ? host === wantedHost.slice(2) || host.endsWith(wantedHost.slice(1))
      : host === wantedHost)
  return hostMatches && globToRegExp(patternPath).test(`${url.pathname}${url.search}`)
}
