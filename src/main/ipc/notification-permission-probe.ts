import { Notification } from 'electron'
import { translateMain } from '../i18n/main-i18n'
import type { NotificationDeliveryProbeResult } from '../../shared/notification-settings-types'
import { activeNotifications } from './native-notification-lifecycle'

const NOTIFICATION_PROBE_RESULT_TIMEOUT_MS = 3000
const NOTIFICATION_PROBE_BANNER_CLOSE_DELAY_MS = 4000

// Fallback delivery evidence is session-scoped because permissions can change between launches.
let lastObservedDeliveryOutcome: 'delivered' | 'failed' | null = null
let deliveryProbeInFlight: Promise<NotificationDeliveryProbeResult> | null = null
// The first probe triggers Electron's permission presenter; avoid repeating it this session.
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

export function resetNotificationPermissionEvidence(): void {
  lastObservedDeliveryOutcome = null
  deliveryProbeInFlight = null
  permissionDialogTriggeredThisSession = false
}

/** Fallback scheduling probe may trigger first-use permission UI; accepted requests can be hidden, so only failure proves blocked delivery. */
export function probeNotificationDelivery(): Promise<NotificationDeliveryProbeResult> {
  if (deliveryProbeInFlight) {
    return deliveryProbeInFlight
  }
  permissionDialogTriggeredThisSession = true

  const probe = new Notification({
    title: translateMain('notifications.test.title', 'Orca notifications are on'),
    body: translateMain(
      'notifications.permissionProbe.body',
      'Orca will alert you when agents finish or terminals need attention.'
    ),
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
      // Leave the probe banner visible briefly as user-facing confirmation.
      const closeTimer = setTimeout(releaseProbe, NOTIFICATION_PROBE_BANNER_CLOSE_DELAY_MS)
      if (typeof closeTimer.unref === 'function') {
        closeTimer.unref()
      }
    }

    function onFailed(_event: unknown, _error?: string): void {
      // Expected permission denial must not spam logs on polling.
      settle('blocked')
      releaseProbe()
    }

    probe.once('show', onShow)
    probe.once('failed', onFailed)
    // Missing callbacks are ambiguous; only the failed event proves failure.
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
