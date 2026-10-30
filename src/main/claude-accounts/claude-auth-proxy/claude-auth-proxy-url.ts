function claudeAuthProxySlotUrl(url: string): URL | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:') {
    return null
  }
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    return null
  }
  if (!/^\/p\/[^/]+\/?$/.test(parsed.pathname)) {
    return null
  }
  return parsed
}

/** Slot id of a loopback `/p/<slot>/` URL. Anything else is a user base URL, not this proxy. */
export function claudeAuthProxySlotId(url: string): string | null {
  return claudeAuthProxySlotUrl(url)?.pathname.match(/^\/p\/([^/]+)\/?$/)?.[1] ?? null
}

/** Port of a loopback `/p/<slot>/` URL. Anything else is a user base URL, not this proxy. */
export function claudeAuthProxySlotPort(url: string): number | null {
  const parsed = claudeAuthProxySlotUrl(url)
  if (!parsed) {
    return null
  }
  const port = parsed.port ? Number(parsed.port) : 80
  return Number.isInteger(port) && port > 0 ? port : null
}

/**
 * A `/p/<slot>/` URL bound to another process. With no listener here, every such URL is foreign:
 * the desktop's loopback port is not reachable from an SSH or WSL guest.
 */
export function isForeignClaudeAuthProxyUrl(url: string, localPort: number | null): boolean {
  const port = claudeAuthProxySlotPort(url)
  if (port === null) {
    return false
  }
  return localPort === null || port !== localPort
}
