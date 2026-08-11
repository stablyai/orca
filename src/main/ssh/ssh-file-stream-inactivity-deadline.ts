import {
  subscribeSystemPowerLifecycle,
  type SystemPowerLifecycleListener
} from '../system-power-lifecycle'

export const SSH_FILE_STREAM_INACTIVITY_TIMEOUT_MS = 60_000

type SystemPowerLifecycleSubscription = (listener: SystemPowerLifecycleListener) => () => void

export function createSshFileStreamInactivityDeadline(
  onTimeout: () => void,
  subscribePowerLifecycle: SystemPowerLifecycleSubscription = subscribeSystemPowerLifecycle
): {
  reset: () => void
  clear: () => void
} {
  let timer: ReturnType<typeof setTimeout> | null = null
  let unsubscribePowerLifecycle: (() => void) | null = null
  let suspended = false
  const clearTimer = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
  const arm = (): void => {
    clearTimer()
    if (suspended) {
      return
    }
    timer = setTimeout(onTimeout, SSH_FILE_STREAM_INACTIVITY_TIMEOUT_MS)
    timer.unref?.()
  }
  const reset = (): void => {
    if (!unsubscribePowerLifecycle) {
      unsubscribePowerLifecycle = subscribePowerLifecycle({
        onSuspend: () => {
          suspended = true
          clearTimer()
        },
        onResume: () => {
          suspended = false
          arm()
        }
      })
    }
    arm()
  }
  const clear = (): void => {
    clearTimer()
    unsubscribePowerLifecycle?.()
    unsubscribePowerLifecycle = null
  }
  return { reset, clear }
}
