import { expect, vi } from 'vitest'
import { MobileNotificationDismissalStore } from './mobile-notification-dismissal-store'
import type {
  RuntimeMobileNotificationController,
  MobileNotificationEvent
} from './runtime-mobile-notification-controller'
import { createHarness, registration, flush } from './push/push-dispatcher.test-fixture'

export function attentionDeliveryTail(
  controller: RuntimeMobileNotificationController,
  root: string
) {
  controller.configureDismissalStore(root)
  const gateway = createHarness({
    devices: [
      { deviceId: 'phone-a', pushRegistration: registration({ registrationId: 'registration-a' }) },
      { deviceId: 'phone-b', pushRegistration: registration({ registrationId: 'registration-b' }) }
    ]
  })
  const events: MobileNotificationEvent[] = []
  const record = vi.spyOn(MobileNotificationDismissalStore.prototype, 'record')
  const stop = controller.onDispatched((event) => {
    events.push(event)
    gateway.dispatcher.enqueue(event)
  })
  const mark = () => ({
    event: events.length,
    record: record.mock.calls.length,
    sends: gateway.sends.length
  })
  return {
    events,
    mark,
    async assertRetired(before: ReturnType<typeof mark>, selected: MobileNotificationEvent[]) {
      await flush()
      const dismissed = events.slice(before.event)
      expect(dismissed).toHaveLength(selected.length)
      expect(dismissed).toEqual(
        selected.map((event) =>
          expect.objectContaining({
            type: 'dismiss',
            notificationId: event.notificationId,
            dismissedDelivery: {
              notificationId: event.notificationId,
              notificationSeq: event.notificationSeq,
              notificationEpoch: event.notificationEpoch
            }
          })
        )
      )
      expect(record.mock.calls.slice(before.record)).toHaveLength(selected.length)
      const plans = gateway.sends.slice(before.sends)
      expect(plans).toHaveLength(selected.length)
      for (const [index, plan] of plans.entries()) {
        expect(plan.registrationIds).toEqual(['registration-a', 'registration-b'])
        expect(plan.notification).toMatchObject({
          kind: 'dismiss',
          notificationId: selected[index]!.notificationId,
          notificationEpoch: selected[index]!.notificationEpoch,
          notificationSeq: selected[index]!.notificationSeq
        })
      }
      await controller.flushDismissals()
      const identities = selected.map((event) => ({
        notificationId: event.notificationId!,
        notificationEpoch: event.notificationEpoch!,
        notificationSeq: event.notificationSeq!
      }))
      expect(controller.reconcileDismissedPushes(identities)).toEqual(identities)
      return {
        dismisses: dismissed.length,
        storeRecords: selected.length,
        listenerDeliveries: dismissed.length,
        gatewayPlans: plans.length,
        registrationsPerPlan: 2
      }
    },
    async close() {
      stop()
      gateway.dispatcher.stop()
      await controller.closeDismissals()
      record.mockRestore()
    }
  }
}
