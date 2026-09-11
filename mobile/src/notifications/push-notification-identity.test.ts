import { expect, it } from 'vitest'
import {
  readPushNotificationIdentity,
  type PushNotificationIdentity
} from './push-notification-identity'

it('reads a bounded individual notification identity', () => {
  const identity: PushNotificationIdentity = {
    notificationId: 'agent:one',
    notificationEpoch: 'epoch-1',
    notificationSeq: 7
  }
  expect(readPushNotificationIdentity(identity)).toEqual(identity)
})

it('rejects incomplete or non-integral notification identities', () => {
  expect(readPushNotificationIdentity({ notificationId: 'agent:one' })).toBeNull()
  expect(
    readPushNotificationIdentity({
      notificationId: 'agent:one',
      notificationEpoch: 'epoch-1',
      notificationSeq: 1.5
    })
  ).toBeNull()
})
