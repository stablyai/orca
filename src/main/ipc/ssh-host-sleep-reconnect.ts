import { powerMonitor } from 'electron'
import type { SshRelaySession } from '../ssh/ssh-relay-session'
import { activeSessions } from './ssh-active-relay-sessions'
import { connectionManager } from './ssh-ipc-context'

let powerMonitorUnsubscribe: (() => void) | null = null

// Why: macOS can resume before the network is back, so a failed first probe gets one retry before the link is declared dead (#7773).
const RESUME_PROBE_TIMEOUT_MS = 5_000
const RESUME_PROBE_ATTEMPTS = 2

async function isRelayLinkAliveAfterResume(session: SshRelaySession): Promise<boolean> {
  const mux = session.getMux()
  if (!mux || mux.isDisposed()) {
    return false
  }
  for (let attempt = 0; attempt < RESUME_PROBE_ATTEMPTS; attempt++) {
    if (await mux.probeLiveness(RESUME_PROBE_TIMEOUT_MS)) {
      return true
    }
  }
  return false
}

export function registerPowerMonitorReconnect(): void {
  powerMonitorUnsubscribe?.()
  const onSuspend = (): void => {
    for (const session of activeSessions.values()) {
      session.prepareForHostSleep()
    }
  }
  const onResume = (): void => {
    for (const [targetId, session] of activeSessions) {
      const manager = connectionManager
      const conn = manager?.getConnection(targetId)
      if (!conn) {
        continue
      }
      void (async () => {
        // Why: unconditional reconnect on wake tore down live sessions and flashed the overlay (#7773); only reconnect if the relay link actually died during sleep.
        if (await isRelayLinkAliveAfterResume(session)) {
          return
        }
        // Why: the probe can take ~10s; bail if the session/connection was replaced or torn down meanwhile, else we'd resurrect it.
        if (activeSessions.get(targetId) !== session || manager?.getConnection(targetId) !== conn) {
          return
        }
        try {
          await manager?.reconnect(targetId)
        } catch (err) {
          console.warn(
            `[ssh] Failed to reconnect ${targetId} after system resume: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        }
      })()
    }
  }
  powerMonitor.on('suspend', onSuspend)
  powerMonitor.on('resume', onResume)
  powerMonitorUnsubscribe = () => {
    powerMonitor.off('suspend', onSuspend)
    powerMonitor.off('resume', onResume)
  }
}

export function unregisterPowerMonitorReconnect(): void {
  powerMonitorUnsubscribe?.()
  powerMonitorUnsubscribe = null
}
