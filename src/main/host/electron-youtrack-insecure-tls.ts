import { session, type Session } from 'electron'
import type { NetworkProxySettings } from '../../shared/network-proxy'
import { applyProxySettingsToSession } from '../network/proxy-settings'
import { setYouTrackInsecureTlsFetch } from '../youtrack/youtrack-request'

// Chromium verify-proc results: 0 accepts the certificate, -3 defers to Chromium's own verdict.
const ACCEPT_CERTIFICATE = 0
const USE_CHROMIUM_VERDICT = -3

// Why one session per host: each verify proc trusts only its own hostname, so a redirect or a
// reconnect to another host can never inherit a relaxed certificate check.
const insecureSessions = new Map<string, Session>()

/**
 * A dedicated, in-memory session for self-hosted YouTrack behind a self-signed or
 * internal-CA certificate. Why not the default session: a verify proc there would also
 * relax TLS for browser tabs and every other integration. Here only the configured
 * YouTrack hostname skips verification; any other host still gets Chromium's verdict.
 */
export async function getInsecureTlsSession(
  hostname: string,
  networkProxySettings: NetworkProxySettings
): Promise<Session> {
  const trustedHostname = hostname.toLowerCase()
  let insecureSession = insecureSessions.get(trustedHostname)
  if (!insecureSession) {
    insecureSession = session.fromPartition(
      `orca-youtrack-insecure-tls-${encodeURIComponent(trustedHostname)}`,
      { cache: false }
    )
    insecureSession.setCertificateVerifyProc((request, callback) => {
      callback(
        request.hostname.toLowerCase() === trustedHostname
          ? ACCEPT_CERTIFICATE
          : USE_CHROMIUM_VERDICT
      )
    })
    insecureSessions.set(trustedHostname, insecureSession)
  }
  // Why every request: applying is memoized per session, and re-reading picks up proxy edits
  // made in Settings, so this partition follows Orca/env/system proxies like the default one.
  await applyProxySettingsToSession(insecureSession, networkProxySettings)
  return insecureSession
}

/** Gives the YouTrack client its opt-in self-signed-TLS transport; the Node-only runtime has none. */
export function installYouTrackInsecureTlsFetch(
  resolveNetworkProxySettings: () => NetworkProxySettings
): void {
  setYouTrackInsecureTlsFetch(async (hostname, url, init) => {
    const insecure = await getInsecureTlsSession(hostname, resolveNetworkProxySettings())
    return insecure.fetch(url, init)
  })
}
