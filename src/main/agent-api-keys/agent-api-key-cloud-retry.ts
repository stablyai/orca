// Saves made while signed in that didn't reach the Orca account (offline, a failed request) are
// retried at start, on wake, and with backoff while Orca is unreachable or a save is pending. The
// timer stops as soon as there is nothing to wait for; the sync kicks it again when there is.
import type { AgentApiKeyCloudSync } from './agent-api-key-cloud-sync'

const FIRST_DELAY_MS = 15_000
const MAX_DELAY_MS = 15 * 60_000

export type AgentApiKeyCloudRetry = {
  /** Something is waiting (a pending save, Orca unreachable) or the network may be back. */
  kick: (options?: { soon?: boolean }) => void
  stop: () => void
}

export function createAgentApiKeyCloudRetry({
  cloud,
  serial,
  notify,
  firstDelayMs = FIRST_DELAY_MS,
  maxDelayMs = MAX_DELAY_MS
}: {
  cloud: Pick<AgentApiKeyCloudSync, 'flushPending' | 'hasPending' | 'lastLink'>
  serial: <T>(run: () => Promise<T>) => Promise<T>
  /** Tells open windows to re-read the keys' state. */
  notify: () => void
  firstDelayMs?: number
  maxDelayMs?: number
}): AgentApiKeyCloudRetry {
  let timer: ReturnType<typeof setTimeout> | null = null
  let delay = firstDelayMs
  let stopped = false
  const waiting = (): boolean => cloud.lastLink === 'unreachable' || cloud.hasPending()

  const run = async (): Promise<void> => {
    timer = null
    try {
      const before = cloud.lastLink
      const changed = await serial(() => cloud.flushPending())
      if (changed || cloud.lastLink !== before) {
        notify()
      }
    } catch {
      // Treated like any other miss: back off and try again.
    }
    if (waiting()) {
      delay = Math.min(delay * 2, maxDelayMs)
      schedule()
    } else {
      delay = firstDelayMs
    }
  }
  const schedule = (): void => {
    if (stopped || timer) {
      return
    }
    timer = setTimeout(() => void run(), delay)
    timer.unref?.()
  }
  return {
    kick: ({ soon = false } = {}) => {
      if (soon) {
        delay = firstDelayMs
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
      }
      schedule()
    },
    stop: () => {
      stopped = true
      if (timer) {
        clearTimeout(timer)
      }
    }
  }
}
