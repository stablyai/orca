import { Notification } from 'electron'
import type { NotificationDeliveryProbeResult } from '../../shared/notification-settings-types'
import { activeNotifications } from './native-notification-lifecycle'

const NOTIFICATION_PROBE_RESULT_TIMEOUT_MS = 3000
const NOTIFICATION_PROBE_BANNER_CLOSE_DELAY_MS = 4000

// Why: no API to read macOS auth, so track the last scheduled notification's outcome; session-scoped since permission can change between runs.
let lastObservedDeliveryOutcome: 'delivered' | 'failed' | null = null
let deliveryProbeInFlight: Promise<NotificationDeliveryProbeResult> | null = null
// Why: firing one probe instantiates Electron's presenter and pops the macOS permission dialog; once per session is enough.
let permissionDialogTriggeredThisSession = false

export function recordNotificationDeliveryOutcome(outcome: 'delivered' | 'failed'): void {
  lastObservedDeliveryOutcome = outcome
}

export function getLastObservedDeliveryOutcome(): 'delivered' | 'failed' | null {
  return lastObservedDeliveryOutcome
}

export function hasTriggeredPermissionDialogThisSession(): boolean {
  return permissionDialogTriggeredThisSession
}

// Why: handler registration marks a fresh session; permission evidence from a previous one must not leak in.
export function resetNotificationPermissionEvidence(): void {
  lastObservedDeliveryOutcome = null
  deliveryProbeInFlight = null
  permissionDialogTriggeredThisSession = false
}

/**
 * Fallback for hosts without the native helper: schedules a silent probe and reports whether macOS accepted it.
 * On a fresh install the probe also instantiates Electron's presenter, which pops the macOS permission dialog.
 *
 * Known ambiguity (verified macOS 26): while undecided, or when notifications are toggled off after being
 * authorized, macOS silently swallows accepted requests, so 'delivered' can over-report; only 'failed' is definitive.
 */
export function probeNotificationDelivery(): Promise<NotificationDeliveryProbeResult> {
  if (deliveryProbeInFlight) {
    return deliveryProbeInFlight
  }
  permissionDialogTriggeredThisSession = true

  const probe = new Notification({
    title: 'Orca notifications are on',
    body: 'Orca will alert you when agents finish or terminals need attention.',
    silent: true
  })
  activeNotifications.add(probe)

  deliveryProbeInFlight = new Promise<NotificationDeliveryProbeResult>((resolve) => {
    let settled = false
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null

    function releaseProbe(): void {
      activeNotifications.delete(probe)
      probe.removeListener('show', onShow)
      probe.removeListener('failed', onFailed)
      probe.close()
    }

    function settle(state: 'delivered' | 'blocked'): void {
      if (settled) {
        return
      }
      settled = true
      if (timeoutTimer) {
        clearTimeout(timeoutTimer)
        timeoutTimer = null
      }
      lastObservedDeliveryOutcome = state === 'delivered' ? 'delivered' : 'failed'
      resolve({ state, authoritative: false })
    }

    function onShow(): void {
      settle('delivered')
      // Why: the probe banner doubles as the user-facing confirmation, so let it linger briefly instead of vanishing instantly.
      const closeTimer = setTimeout(releaseProbe, NOTIFICATION_PROBE_BANNER_CLOSE_DELAY_MS)
      if (typeof closeTimer.unref === 'function') {
        closeTimer.unref()
      }
    }

    function onFailed(_event: unknown, _error?: string): void {
      // Why: a rejected probe is expected (denied permission); don't log — it would spam the console on every poll.
      settle('blocked')
      releaseProbe()
    }

    probe.once('show', onShow)
    probe.once('failed', onFailed)
    // Why: don't record 'failed' on timeout — a missing callback is ambiguous, only the 'failed' event is definitive.
    timeoutTimer = setTimeout(() => {
      if (!settled) {
        settled = true
        resolve({ state: 'blocked', authoritative: false })
        releaseProbe()
      }
    }, NOTIFICATION_PROBE_RESULT_TIMEOUT_MS)
    if (typeof timeoutTimer.unref === 'function') {
      timeoutTimer.unref()
    }

    probe.show()
  }).finally(() => {
    deliveryProbeInFlight = null
  })

  return deliveryProbeInFlight
}
