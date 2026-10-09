import { net, session } from 'electron'
import type { MainHttpClient } from '../network/http-client'
import { hasElectronProxyCredentialsForSession } from '../network/electron-proxy-credentials'
import { getProxySessionApplicationReadiness } from '../network/proxy-settings'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { fetchElectronProxyRequest } from './electron-proxy-fetch'

function isHttpUrl(url: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol)
  } catch {
    return false
  }
}

async function fetchWithConfiguredProxyAuthentication(
  url: string,
  init?: RequestInit
): Promise<Response> {
  if (!isHttpUrl(url)) {
    return net.fetch(url, init)
  }
  const proxySession = session.defaultSession
  const signal = init?.signal ?? undefined
  const ready = await waitForPromiseWithSignal(
    Promise.resolve(getProxySessionApplicationReadiness(proxySession)),
    signal
  ).catch((error: unknown) => {
    // Fetch preserves arbitrary abort reasons, including values that are not Errors.
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
    }
    throw error
  })
  if (!ready) {
    throw new Error('Proxy session is unavailable')
  }
  if (!hasElectronProxyCredentialsForSession(proxySession)) {
    return net.fetch(url, init)
  }
  return fetchElectronProxyRequest(new Request(url, init), proxySession)
}

/**
 * The desktop HTTP client: Chromium's network stack, which follows session and proxy
 * state and sends a Chrome user agent.
 *
 * `session.defaultSession` throws before the app is ready, so it is read per call
 * rather than captured at install time.
 */
export const electronHttpClient: MainHttpClient = {
  fetch: fetchWithConfiguredProxyAuthentication,
  proxySession: () => session.defaultSession
}
