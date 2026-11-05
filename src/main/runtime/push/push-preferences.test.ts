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
