import { net, session } from 'electron'
import { setManagedFetch, setProxyPrimer } from '../../shared/managed-fetch'
import { ensureElectronProxyFromEnvironment } from './proxy-settings'

/**
 * Install the Electron-backed managed fetch: outbound requests go through
 * `net.fetch` (Chromium proxy/session state, no stale keep-alive after VPN
 * changes), with proxy config primed from the environment before each request.
 * The headless server skips this and uses Node's global fetch instead.
 */
export function installElectronManagedFetch(): void {
  setManagedFetch((url, init) => net.fetch(url, init as RequestInit))
  setProxyPrimer(async (url) => {
    await ensureElectronProxyFromEnvironment({
      proxySession: session.defaultSession,
      probeUrl: url
    })
  })
}
