const ALL_URLS_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:', 'ftp:', 'file:'])
const PATTERN = /^(\*|[a-z][a-z0-9+.-]*):\/\/(\*|\*\.[^/*]+|[^/*]*)(\/.*)$/

/** Whether `url` matches a Chrome extension match pattern such as `*://*.example.com/*`. */
export function matchesUrlPattern(pattern: string, url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (pattern === '<all_urls>') {
    return ALL_URLS_SCHEMES.has(parsed.protocol)
  }
  const match = PATTERN.exec(pattern)
  if (!match) {
    return false
  }
  const [, scheme, host, path] = match
  const urlScheme = parsed.protocol.slice(0, -1)
  const schemeMatches =
    scheme === '*' ? urlScheme === 'http' || urlScheme === 'https' : scheme === urlScheme
  return (
    schemeMatches &&
    matchesHost(host, parsed.hostname) &&
    globToRegExp(path).test(parsed.pathname + parsed.search)
  )
}

function matchesHost(pattern: string, hostname: string): boolean {
  if (pattern === '*') {
    return true
  }
  if (pattern.startsWith('*.')) {
    const domain = pattern.slice(2)
    return hostname === domain || hostname.endsWith(`.${domain}`)
  }
  return hostname === pattern
}

/** A `*`-wildcard pattern, as tabs.query's `title` and match-pattern paths use, as a RegExp. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

function manifestPermissions(extension: Electron.Extension): unknown[] {
  const manifest = extension.manifest
  return [
    ...(Array.isArray(manifest.permissions) ? manifest.permissions : []),
    ...(Array.isArray(manifest.host_permissions) ? manifest.host_permissions : [])
  ]
}

/** Whether the manifest declares an API permission such as "cookies". */
export function extensionHasPermission(extension: Electron.Extension, name: string): boolean {
  return manifestPermissions(extension).includes(name)
}

/** Whether a host permission covers `url`; "tabs" alone does not grant one. */
export function extensionHasHostPermission(extension: Electron.Extension, url: string): boolean {
  return manifestPermissions(extension).some(
    (permission) =>
      typeof permission === 'string' &&
      // Why: Chrome requires a path in a host permission but ignores its value.
      matchesUrlPattern(permission.replace(/^([^:]+:\/\/[^/]*)\/.*$/, '$1/*'), url)
  )
}

/** Whether the extension may see `url`: the "tabs" permission or a host permission covering it. */
export function extensionCanSeeUrl(extension: Electron.Extension, url: string): boolean {
  return extensionHasPermission(extension, 'tabs') || extensionHasHostPermission(extension, url)
}
