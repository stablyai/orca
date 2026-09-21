import { expect, it } from 'vitest'
import { createHarness, notification, registration, flush } from './push-dispatcher.test-fixture'

it('applies desktop category eligibility regardless of phone sound preferences', async () => {
  const harness = createHarness({
    devices: [
      {
        deviceId: 'mirror',
        pushRegistration: registration({
          registrationId: 'mirror'
        })
      },
      {
        deviceId: 'quiet',
        pushRegistration: registration({
          registrationId: 'quiet',
          filter: { sound: false }
        })
      },
      {
        deviceId: 'second-phone',
        pushRegistration: registration({ registrationId: 'second-phone' })
      }
    ]
  })
  harness.dispatcher.enqueue(notification({ source: 'terminal-bell', desktopAllowed: false }))
  await flush()
  expect(harness.sends).toHaveLength(0)

  harness.dispatcher.enqueue(notification({ source: 'terminal-bell', desktopAllowed: true }))
  await flush()
  expect(harness.sends).toHaveLength(2)
  expect(harness.sends[0]).toMatchObject({ registrationIds: ['mirror', 'second-phone'] })
  expect(harness.sends[1]).toMatchObject({
    registrationIds: ['quiet'],
    notification: { sound: false }
  })
})

it('keeps sound preferences separate when several phones receive the same event', async () => {
  const harness = createHarness({
    devices: [
      { deviceId: 'loud', pushRegistration: registration({ registrationId: 'loud' }) },
      {
        deviceId: 'quiet',
        pushRegistration: registration({
          registrationId: 'quiet',
          filter: { ...registration().filter, sound: false }
        })
      }
    ]
  })
  harness.dispatcher.enqueue(notification())
  await flush()
  expect(harness.sends).toHaveLength(2)
  expect(harness.sends[0]).toMatchObject({ registrationIds: ['loud'] })
  expect(harness.sends[0].notification.sound).toBeUndefined()
  expect(harness.sends[1]).toMatchObject({
    registrationIds: ['quiet'],
    notification: { sound: false }
  })
})

it('applies burst suppression independently to each eligible phone', async () => {
  const harness = createHarness({
    devices: [
      {
        deviceId: 'all',
        pushRegistration: registration({
          registrationId: 'all'
        })
      },
      {
        deviceId: 'second-phone',
        pushRegistration: registration({
          registrationId: 'second-phone'
        })
      }
    ]
  })
  harness.dispatcher.enqueue(notification({ source: 'terminal-bell', emittedAt: 10000 }))
  harness.dispatcher.enqueue(notification({ emittedAt: 10250 }))
  await flush()
  expect(harness.sends.map((send) => send.registrationIds)).toEqual([['all', 'second-phone']])
})
