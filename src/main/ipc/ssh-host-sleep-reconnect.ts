import { powerMonitor } from 'electron'
import { recoverOrcadManagedTunnelsAfterHostResume } from '../ssh/orcad-managed-tunnel'
import { errorMessage } from '../../shared/error-message'

let powerMonitorUnsubscribe: (() => void) | null = null

// Why: macOS can resume before the network is back, so a failed first probe gets one retry before the link is declared dead (#7773).
const RESUME_PROBE_TIMEOUT_MS = 5_000
const RESUME_PROBE_ATTEMPTS = 2

export function registerPowerMonitorReconnect(getUserDataPath?: () => string): void {
  powerMonitorUnsubscribe?.()
  const onResume = (): void => {
    if (getUserDataPath) {
      void recoverOrcadManagedTunnelsAfterHostResume(getUserDataPath(), {
        attempts: RESUME_PROBE_ATTEMPTS,
        timeoutMs: RESUME_PROBE_TIMEOUT_MS
      }).catch((err) => {
        console.warn(
          `[ssh] Failed to recover a managed Orca tunnel after system resume: ${errorMessage(err)}`
        )
      })
    }
  }
  powerMonitor.on('resume', onResume)
  powerMonitorUnsubscribe = () => {
    powerMonitor.off('resume', onResume)
  }
}

export function unregisterPowerMonitorReconnect(): void {
  powerMonitorUnsubscribe?.()
  powerMonitorUnsubscribe = null
}
