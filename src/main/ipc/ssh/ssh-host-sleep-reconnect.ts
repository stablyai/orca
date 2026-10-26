import { powerMonitor } from 'electron'
import { recoverOrcadManagedTunnelsAfterHostResume } from '../../managed-server/lifecycle/orcad-managed-tunnel'
import { getSshConnectionManager } from '../../ssh/targets/ssh-target-registry'
import { errorMessage } from '../../../shared/error-message'

let powerMonitorUnsubscribe: (() => void) | null = null
let registeredGetUserDataPath: (() => string) | undefined

// macOS can wake before networking; allow one retry before declaring a link dead (#7773).
const RESUME_PROBE_TIMEOUT_MS = 5_000
const RESUME_PROBE_ATTEMPTS = 2

/** Real wake/unlock/online signals refresh a reconnect budget spent during silent macOS dark wakes. */
export function retrySshConnectionsAfterNetworkReturn(): void {
  const restarted = getSshConnectionManager()?.retryStalledReconnects() ?? []
  if (restarted.length > 0) {
    console.warn(`[ssh] Retrying ${restarted.length} stalled SSH reconnect(s) after wake/network`)
  }
  const getUserDataPath = registeredGetUserDataPath
  if (!getUserDataPath) {
    return
  }
  // Probe transports that still appear connected after wake; keepalive may not detect them yet.
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
  // macOS/Windows lock without sleep can still drop VPN routes.
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
