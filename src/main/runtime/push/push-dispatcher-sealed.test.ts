import { describe, expect, it } from 'vitest'
import { createHarness, flush, notification, registration } from './push-dispatcher.test-fixture'
import { openSealedPushNotification } from './push-e2e-seal.test-fixture'

describe('PushDispatcher sealed content', () => {
  it('seals pushes for phones that opted in and leaves older phones readable', async () => {
    const harness = createHarness({
      devices: [
        {
          deviceId: 'sealed-a',
          pushRegistration: registration({ registrationId: 'reg-a', sealedContent: 'e2e1' })
        },
        { deviceId: 'legacy', pushRegistration: registration({ registrationId: 'reg-legacy' }) },
        {
          deviceId: 'sealed-b',
          pushRegistration: registration({
            registrationId: 'reg-b',
            sealedContent: 'e2e1',
            filter: { sound: false }
          })
        }
      ]
    })

    harness.dispatcher.enqueue(notification())
    harness.dispatcher.enqueue({
      type: 'dismiss',
      notificationId: 'agent:one',
      notificationSeq: 8,
      notificationEpoch: 'epoch-1'
    })
    await flush()

    const byRegistration = (id: string) =>
      harness.sends.filter((send) => send.registrationIds.includes(id))
    const [legacyAlert] = byRegistration('reg-legacy')
    expect(legacyAlert).toMatchObject({
      registrationIds: ['reg-legacy'],
      notification: { title: 'feat/x - Claude finished', body: 'All done.' }
    })
    const [alertA, dismissA] = byRegistration('reg-a')
    const [alertB, dismissB] = byRegistration('reg-b')
    for (const send of [alertA, dismissA, alertB, dismissB]) {
      expect(send?.registrationIds).toHaveLength(1)
      const wire = JSON.stringify(send)
      expect(wire).not.toMatch(/feat\/x|All done\.|repo::wt1|agent:one|epoch-1/)
    }
    expect(alertB?.notification.sound).toBe(false)
    expect(openSealedPushNotification(alertA!.notification, 'token-sealed-a')).toMatchObject({
      title: 'feat/x - Claude finished',
      body: 'All done.',
      worktreeId: 'repo::wt1',
      notificationId: 'agent:one',
      notificationEpoch: 'epoch-1'
    })
    // The gateway refuses a differing copy of an event it already holds, so each phone's event differs.
    expect(alertA?.notification.notificationEpoch).not.toBe(alertB?.notification.notificationEpoch)
    // A dismissal names the alert it retracts by that phone's own opaque ids.
    expect(dismissA?.notification).toMatchObject({
      kind: 'dismiss',
      notificationId: alertA?.notification.notificationId,
      notificationEpoch: alertA?.notification.notificationEpoch
    })
    expect(dismissB?.notification.notificationId).toBe(alertB?.notification.notificationId)
  })

  it('never sends readable text to a sealed phone without a pairing token', async () => {
    const harness = createHarness({
      devices: [
        { deviceId: 'a', token: '', pushRegistration: registration({ sealedContent: 'e2e1' }) }
      ]
    })

    harness.dispatcher.enqueue(notification())
    await flush()

    expect(harness.sends).toHaveLength(0)
  })
})
