import { getDaemonProvider } from './daemon-provider-state'
import { DEGRADED_DAEMON_RECOVERY_RETRY_MS } from './degraded-daemon-fresh-spawn-routing'

export const LATE_DAEMON_ADOPTION_ATTEMPTS = 3

/** After startup falls back to in-process PTYs, retry so later fresh terminals reach a host that came up late. */
export function scheduleLateDaemonAdoption(
  adopt: () => Promise<void>,
  isQuitting: () => boolean,
  attemptsLeft = LATE_DAEMON_ADOPTION_ATTEMPTS
): void {
  const timer = setTimeout(() => {
    if (getDaemonProvider() || isQuitting()) {
      return
    }
    adopt().then(
      () => console.info('[daemon] Adopted the terminal host after startup fallback'),
      (error: unknown) => {
        console.warn('[daemon] Could not adopt the terminal host after startup fallback', error)
        if (attemptsLeft > 1) {
          scheduleLateDaemonAdoption(adopt, isQuitting, attemptsLeft - 1)
        }
      }
    )
  }, DEGRADED_DAEMON_RECOVERY_RETRY_MS)
  timer.unref?.()
}
