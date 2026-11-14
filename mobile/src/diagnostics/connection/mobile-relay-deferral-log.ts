import type { RelayRecoveryLog } from './mobile-relay-recovery-log'
import type { RelayReconnectController } from '../../transport/relay/mobile-relay-reconnect-controller'

type RelayRecoveryDeferral = NonNullable<ReturnType<RelayReconnectController['deferral']>>

// Every direct-dial state flap re-enters relay recovery and hits the same cooldown, so an
// unroutable LAN address once wrote this line every few seconds. Log a reason change at once and
// otherwise one line per window, counting what it stood for.
const DEFERRAL_LOG_INTERVAL_MS = 30_000

export function createRelayDeferralLog(
  log: RelayRecoveryLog,
  now: () => number = Date.now
): (deferral: RelayRecoveryDeferral) => void {
  let last: { reason: RelayRecoveryDeferral['reason']; at: number } | null = null
  let suppressed = 0
  return ({ reason, remainingMs }) => {
    const at = now()
    if (last?.reason === reason && at - last.at < DEFERRAL_LOG_INTERVAL_MS) {
      suppressed += 1
      return
    }
    const kind = reason === 'cooldown' ? 'cooldown' : `gate=${reason}`
    const repeats = suppressed > 0 ? ` suppressedSinceLastLine=${suppressed}` : ''
    log(`recovery deferred by ${kind}`, `retryInMs=${remainingMs}${repeats}`)
    last = { reason, at }
    suppressed = 0
  }
}
