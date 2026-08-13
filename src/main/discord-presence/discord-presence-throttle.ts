import type { DiscordActivity } from './discord-presence-activity'

export type PresenceThrottle = {
  (activity: DiscordActivity | null): void
  flush(): void
}

const DEFAULT_INTERVAL_MS = 15000

export function createPresenceThrottle(
  publish: (activity: DiscordActivity | null) => void,
  intervalMs: number = DEFAULT_INTERVAL_MS
): PresenceThrottle {
  let pending: DiscordActivity | null | undefined = undefined
  let lastPublished: DiscordActivity | null | undefined = undefined
  let lastTime = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  function scheduleTrailing() {
    if (timer) return
    const remaining = intervalMs - (Date.now() - lastTime)
    timer = setTimeout(() => {
      timer = null
      if (pending !== undefined && pending !== lastPublished) {
        lastPublished = pending
        publish(pending!)
      }
      pending = undefined
      lastTime = Date.now()
    }, Math.max(0, remaining))
  }

  function throttled(activity: DiscordActivity | null): void {
    const now = Date.now()

    // First update or cooldown passed: publish immediately (leading)
    if (lastTime === 0 || now - lastTime >= intervalMs) {
      lastPublished = activity
      publish(activity)
      lastTime = now
      pending = undefined
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      return
    }

    // Queue for trailing — coalesce to last value
    pending = activity
    scheduleTrailing()
  }

  throttled.flush = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (pending !== undefined && pending !== lastPublished) {
      lastPublished = pending
      publish(pending!)
    }
    pending = undefined
    lastTime = Date.now()
  }

  return throttled
}