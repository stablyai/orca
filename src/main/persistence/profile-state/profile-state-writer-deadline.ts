import {
  getSystemPowerState,
  subscribeSystemPowerLifecycle,
  type SystemPowerLifecycleListener,
  type SystemPowerState
} from '../../system-power-lifecycle'

/**
 * A timer this late proves the main loop, not the worker, missed the window: a
 * reply may already be queued behind it. Timers and performance.now() share
 * libuv's monotonic clock, so wall-clock changes cannot fake or hide lateness.
 */
export const PROFILE_STATE_WRITER_OVERDUE_GRACE_MS = 5_000
/** Stalls, suspended expiries, and resumes share one budget per request. */
export const PROFILE_STATE_WRITER_MAX_GRACES = 3

export type ProfileStateWriterDeadlineExpiry = {
  timeoutMs: number
  elapsedMs: number
  overdueMs: number
  graces: number
  powerState: SystemPowerState
}

export type ProfileStateWriterDeadlineOptions = {
  now?: () => number
  subscribePowerLifecycle?: (listener: SystemPowerLifecycleListener) => () => void
  onGrace?: (expiry: ProfileStateWriterDeadlineExpiry) => void
}

/**
 * Power events and stalled-loop expiries can grant bounded extra time.
 * A final expiry lets queued replies drain before faulting.
 */
export function createProfileStateWriterDeadline(
  timeoutMs: number,
  onTimeout: (expiry: ProfileStateWriterDeadlineExpiry) => void,
  {
    now = () => performance.now(),
    subscribePowerLifecycle = subscribeSystemPowerLifecycle,
    onGrace
  }: ProfileStateWriterDeadlineOptions = {}
): { clear: () => void } {
  const startedAt = now()
  let armedAt = startedAt
  let graces = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let timeoutCheck: ReturnType<typeof setImmediate> | undefined
  let active = true
  const arm = (): void => {
    clearTimeout(timer)
    clearImmediate(timeoutCheck)
    timeoutCheck = undefined
    armedAt = now()
    timer = setTimeout(expire, timeoutMs)
  }
  const clear = (): void => {
    if (!active) {
      return
    }
    active = false
    clearTimeout(timer)
    timer = undefined
    clearImmediate(timeoutCheck)
    timeoutCheck = undefined
    unsubscribe()
  }
  const describeExpiry = (): ProfileStateWriterDeadlineExpiry => {
    const current = now()
    return {
      timeoutMs,
      elapsedMs: Math.max(0, current - startedAt),
      overdueMs: Math.max(0, current - armedAt - timeoutMs),
      graces,
      powerState: getSystemPowerState()
    }
  }
  const grantGrace = (expiry: ProfileStateWriterDeadlineExpiry): boolean => {
    if (graces >= PROFILE_STATE_WRITER_MAX_GRACES) {
      return false
    }
    graces += 1
    arm()
    onGrace?.({ ...expiry, graces })
    return true
  }
  function expire(): void {
    timer = undefined
    if (!active) {
      return
    }
    const expiry = describeExpiry()
    if (
      (expiry.overdueMs >= PROFILE_STATE_WRITER_OVERDUE_GRACE_MS ||
        expiry.powerState !== 'awake') &&
      grantGrace(expiry)
    ) {
      return
    }
    // Windows can deliver a queued worker reply after the first poll following a stall.
    timeoutCheck = setImmediate(() => {
      timeoutCheck = setImmediate(() => {
        timeoutCheck = undefined
        if (active) {
          clear()
          onTimeout(expiry)
        }
      })
    })
  }
  // Subscription replays the current state synchronously; only later resumes re-arm.
  let subscribed = false
  const unsubscribe = subscribePowerLifecycle({
    onSuspend: () => {},
    onResume: () => {
      if (subscribed && active) {
        grantGrace(describeExpiry())
      }
    }
  })
  subscribed = true
  arm()
  return { clear }
}
