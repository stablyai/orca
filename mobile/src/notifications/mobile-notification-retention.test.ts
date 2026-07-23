import { describe, expect, it } from 'vitest'
import {
  MOBILE_NOTIFICATION_ACTIVE_MAX_BYTES,
  MOBILE_NOTIFICATION_EVENT_MAX_BYTES,
  MOBILE_NOTIFICATION_HOST_ID_MAX_BYTES,
  MOBILE_NOTIFICATION_ID_MAX_BYTES,
  MobileNotificationDeliveryLedger,
  measureMobileNotificationDeliveryBytes
} from './mobile-notification-retention'
import {
  MOBILE_NATIVE_NOTIFICATION_ID_MAX_BYTES,
  MOBILE_SCHEDULED_NOTIFICATION_MAX_RETAINED_BYTES,
  MobileScheduledNotificationRegistry
} from './mobile-scheduled-notification-registry'

describe('mobile notification retention', () => {
  it('accepts an exact-limit event and rejects one more byte', () => {
    const baseEvent = {
      type: 'notification',
      source: 'test',
      title: '',
      body: '',
      notificationId: 'notification-1'
    }
    const baseBytes = measureMobileNotificationDeliveryBytes(baseEvent, 'host-1')!
    const exactEvent = {
      ...baseEvent,
      body: 'x'.repeat(MOBILE_NOTIFICATION_EVENT_MAX_BYTES - baseBytes)
    }

    expect(measureMobileNotificationDeliveryBytes(exactEvent, 'host-1')).toBe(
      MOBILE_NOTIFICATION_EVENT_MAX_BYTES
    )
    expect(
      measureMobileNotificationDeliveryBytes(
        { ...exactEvent, body: `${exactEvent.body}x` },
        'host-1'
      )
    ).toBeNull()
  })

  it('bounds host and notification identifiers before URI key expansion', () => {
    const event = {
      type: 'dismiss',
      notificationId: 'n'.repeat(MOBILE_NOTIFICATION_ID_MAX_BYTES)
    }

    expect(
      measureMobileNotificationDeliveryBytes(
        event,
        'h'.repeat(MOBILE_NOTIFICATION_HOST_ID_MAX_BYTES)
      )
    ).not.toBeNull()
    expect(
      measureMobileNotificationDeliveryBytes(
        { ...event, notificationId: `${event.notificationId}n` },
        'host-1'
      )
    ).toBeNull()
    expect(
      measureMobileNotificationDeliveryBytes(
        event,
        'h'.repeat(MOBILE_NOTIFICATION_HOST_ID_MAX_BYTES + 1)
      )
    ).toBeNull()
  })

  it('caps aggregate active bytes and restores capacity on release', () => {
    const ledger = new MobileNotificationDeliveryLedger()
    const baseEvent = { type: 'notification', title: '', body: '' }
    const baseBytes = measureMobileNotificationDeliveryBytes(baseEvent, 'host-1')!
    const exactEvent = {
      ...baseEvent,
      body: 'x'.repeat(MOBILE_NOTIFICATION_EVENT_MAX_BYTES - baseBytes)
    }
    const exactClaims = MOBILE_NOTIFICATION_ACTIVE_MAX_BYTES / MOBILE_NOTIFICATION_EVENT_MAX_BYTES
    const releases = Array.from({ length: exactClaims }, () => ledger.claim(exactEvent, 'host-1'))

    expect(releases.every(Boolean)).toBe(true)
    expect(ledger.claim(exactEvent, 'host-1')).toBeNull()
    releases[0]?.()
    expect(ledger.claim(exactEvent, 'host-1')).not.toBeNull()
  })

  it('rejects a scheduled key that alone exceeds the aggregate budget', () => {
    const registry = new MobileScheduledNotificationRegistry()
    const maximumKeyCharacters = (MOBILE_SCHEDULED_NOTIFICATION_MAX_RETAINED_BYTES - 64) / 2

    expect(registry.reserve('x'.repeat(maximumKeyCharacters))).not.toBeNull()
    registry.resetForTests()
    expect(registry.reserve('x'.repeat(maximumKeyCharacters + 1))).toBeNull()
  })

  it('retains exact-limit native ids and rejects oversized values', () => {
    const registry = new MobileScheduledNotificationRegistry()
    const exactState = registry.reserve('exact')!.state
    const oversizedState = registry.reserve('oversized')!.state

    expect(
      registry.retainIdentifier(exactState, 'x'.repeat(MOBILE_NATIVE_NOTIFICATION_ID_MAX_BYTES))
    ).toBe(true)
    expect(
      registry.retainIdentifier(
        oversizedState,
        'x'.repeat(MOBILE_NATIVE_NOTIFICATION_ID_MAX_BYTES + 1)
      )
    ).toBe(false)
    expect(registry.getRetainedBytesForTests()).toBeLessThanOrEqual(
      MOBILE_SCHEDULED_NOTIFICATION_MAX_RETAINED_BYTES
    )
  })
})
