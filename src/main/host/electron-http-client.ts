import { net, session } from 'electron'
import type { MainHttpClient } from '../network/http-client'

/**
 * The desktop HTTP client: Chromium's network stack, which follows session and proxy
 * state and sends a Chrome user agent.
 *
 * `session.defaultSession` throws before the app is ready, so it is read per call
 * rather than captured at install time.
 */
export const electronHttpClient: MainHttpClient = {
  fetch: (input, init) => net.fetch(input instanceof URL ? input.toString() : input, init),
  fetchWithSystemTrust: (input, init) =>
    net.fetch(input instanceof URL ? input.toString() : input, init),
  proxySession: () => session.defaultSession
}
