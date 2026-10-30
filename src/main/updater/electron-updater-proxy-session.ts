import { session, type AuthInfo, type Session } from 'electron'
import type { NetworkProxySettings } from '../../shared/network-proxy'
import { getElectronProxyCredentialsForChallenge } from '../network/electron-proxy-credentials'
import { installElectronProxyRequestGuard } from '../network/electron-proxy-request-guard'
import { applyElectronProxySettings } from '../network/proxy-settings'

// Must match electron-updater's NET_SESSION_NAME partition and options (out/electronHttpExecutor.js).
const ELECTRON_UPDATER_PARTITION = 'electron-updater'

let guardedSession: Session | null = null

function getElectronUpdaterSession(): Session {
  const updaterSession = session.fromPartition(ELECTRON_UPDATER_PARTITION, { cache: false })
  if (guardedSession !== updaterSession) {
    // Hold update requests until the newest proxy policy settles, like the default session.
    installElectronProxyRequestGuard(updaterSession)
    guardedSession = updaterSession
  }
  return updaterSession
}

/** electron-updater uses its own partition, so app proxy settings must be applied to it separately. */
export async function applyProxyToElectronUpdaterSession(
  settings: NetworkProxySettings
): Promise<void> {
  try {
    await applyElectronProxySettings(settings, { proxySession: getElectronUpdaterSession() })
  } catch {
    console.warn('[updater] failed to apply network proxy settings to updater session')
  }
}

export function handleElectronUpdaterProxyLogin(
  authInfo: AuthInfo,
  callback: (username: string, password: string) => void
): void {
  const credentials = getElectronProxyCredentialsForChallenge(getElectronUpdaterSession(), authInfo)
  if (credentials) {
    callback(credentials.username, credentials.password)
  }
}
