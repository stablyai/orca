import { markRpcDeliveryUnknown } from './rpc-delivery-ambiguity'
import { startForegroundClock } from './socket-deadline-clock'

// Time fetch-wide inactivity; a queued read on a slow moving link can exceed a per-request stall budget (#29697).
export const MOBILE_WEB_BUNDLE_WINDOW_STALL_MS = 30_000

export type WindowStallClock = {
  // Rejects as a lost link once no window has landed for the budget of foreground time.
  readonly stalled: Promise<never>
  arm(): void
  disarm(): void
}

export function createWindowStallClock(stopped: AbortController): WindowStallClock {
  let timer: ReturnType<typeof setTimeout> | null = null
  let fail: (error: Error) => void = () => {}
  const stalled = new Promise<never>((_, reject) => {
    fail = reject
  })
  const disarm = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
  const arm = (): void => {
    disarm()
    // A read that lands after the fetch settled must not leave a timer behind.
    if (stopped.signal.aborted) {
      return
    }
    const foregroundElapsed = startForegroundClock()
    const expire = (): void => {
      const left = MOBILE_WEB_BUNDLE_WINDOW_STALL_MS - foregroundElapsed()
      if (left > 0) {
        timer = setTimeout(expire, left)
        return
      }
      timer = null
      stopped.abort()
      fail(
        markRpcDeliveryUnknown(
          new Error(
            `mobile web bundle fetch stalled: no window arrived in ${MOBILE_WEB_BUNDLE_WINDOW_STALL_MS}ms`
          )
        )
      )
    }
    timer = setTimeout(expire, MOBILE_WEB_BUNDLE_WINDOW_STALL_MS)
  }
  return { stalled, arm, disarm }
}
