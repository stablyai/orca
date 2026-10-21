import { powerMonitor } from 'electron'
import { recoverOrcadManagedTunnelsAfterHostResume } from '../../managed-server/lifecycle/orcad-managed-tunnel'
import { getSshConnectionManager } from '../../ssh/targets/ssh-target-registry'
import { errorMessage } from '../../../shared/error-message'

let powerMonitorUnsubscribe: (() => void) | null = null
let registeredGetUserDataPath: (() => string) | undefined

// Why: macOS can resume before the network is back, so a failed first probe gets one retry before the link is declared dead (#7773).
const RESUME_PROBE_TIMEOUT_MS = 5_000
const RESUME_PROBE_ATTEMPTS = 2

/**
 * Wake, unlock, or the window's resume/online signal. Why each: the ladder can spend itself in
 * macOS dark wakes, which emit no resume, so only the next real signal can give it a fresh budget.
 */
export function retrySshConnectionsAfterNetworkReturn(): void {
  const restarted = getSshConnectionManager()?.retryStalledReconnects() ?? []
  if (restarted.length > 0) {
    console.warn(`[ssh] Retrying ${restarted.length} stalled SSH reconnect(s) after wake/network`)
  }
  const getUserDataPath = registeredGetUserDataPath
  if (!getUserDataPath) {
    return
  }
  // Why: a transport that still looks connected after wake is found dead by this probe, not by keepalive.
  void recoverOrcadManagedTunnelsAfterHostResume(getUserDataPath(), {
    attempts: RESUME_PROBE_ATTEMPTS,
    timeoutMs: RESUME_PROBE_TIMEOUT_MS
  }).catch((err) => {
    console.warn(
      `[ssh] Failed to recover a managed Orca tunnel after system resume: ${errorMessage(err)}`
    )
  })
}

export function registerPowerMonitorReconnect(getUserDataPath?: () => string): void {
  powerMonitorUnsubscribe?.()
  registeredGetUserDataPath = getUserDataPath
  const onResume = (): void => retrySshConnectionsAfterNetworkReturn()
  powerMonitor.on('resume', onResume)
  // Why: macOS and Windows only; a lock without sleep can still drop a VPN route such as Tailscale's.
  powerMonitor.on('unlock-screen', onResume)
  powerMonitorUnsubscribe = () => {
    powerMonitor.off('resume', onResume)
    powerMonitor.off('unlock-screen', onResume)
  }
}

export function unregisterPowerMonitorReconnect(): void {
  powerMonitorUnsubscribe?.()
  powerMonitorUnsubscribe = null
  registeredGetUserDataPath = undefined
}
