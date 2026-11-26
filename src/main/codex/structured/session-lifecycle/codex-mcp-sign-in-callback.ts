const CALLBACK_FETCH_TIMEOUT_MS = 15_000
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

export function readRedirectUri(authorizationUrl: string): string | null {
  try {
    // A server-planted second redirect_uri could steer the host's GET elsewhere.
    const uris = new URL(authorizationUrl).searchParams.getAll('redirect_uri')
    return uris.length === 1 ? uris[0]! : null
  } catch {
    return null
  }
}

/** A host-side GET of pasted input: only Codex's own loopback callback for this login. */
export function matchingCodexMcpCallback(
  callbackUrl: string,
  redirectUri: string | null
): URL | null {
  try {
    const url = new URL(callbackUrl.trim())
    const expected = new URL(redirectUri ?? '')
    return url.protocol === 'http:' &&
      LOOPBACK_HOSTS.has(url.hostname) &&
      !url.username &&
      !url.password &&
      url.origin === expected.origin &&
      url.pathname === expected.pathname
      ? url
      : null
  } catch {
    return null
  }
}

export async function deliverCodexMcpCallback(callback: URL): Promise<void> {
  let response: Response
  try {
    response = await fetch(callback, {
      redirect: 'manual',
      signal: AbortSignal.timeout(CALLBACK_FETCH_TIMEOUT_MS)
    })
  } catch {
    throw new Error('The sign-in is no longer waiting. Start it again.')
  }
  await response.body?.cancel()
  if (!response.ok) {
    throw new Error(
      `Codex refused that address (HTTP ${response.status}). Start the sign-in again.`
    )
  }
}
