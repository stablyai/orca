import { expect, it } from 'vitest'
import {
  readPushNotificationIdentity,
  type PushNotificationIdentity
} from './push-notification-identity'

it('reads a bounded individual notification identity', () => {
  const identity: PushNotificationIdentity = {
    notificationId: 'n'.repeat(2048),
    notificationEpoch: 'e'.repeat(128),
    notificationSeq: Number.MAX_SAFE_INTEGER
  }
  expect(readPushNotificationIdentity(identity)).toEqual(identity)
})

it('rejects incomplete or out-of-bounds notification identities', () => {
  const identity = {
    notificationId: 'agent:one',
    notificationEpoch: 'epoch-1',
    notificationSeq: 7
  }
  expect(readPushNotificationIdentity({ notificationId: 'agent:one' })).toBeNull()
  for (const invalid of [
    { notificationId: '' },
    { notificationId: 'n'.repeat(2049) },
    { notificationEpoch: '' },
    { notificationEpoch: 'e'.repeat(129) },
    { notificationEpoch: undefined },
    { notificationSeq: undefined },
    { notificationSeq: -1 },
    { notificationSeq: 1.5 },
    { notificationSeq: Number.MAX_SAFE_INTEGER + 1 }
  ]) {
    expect(readPushNotificationIdentity({ ...identity, ...invalid })).toBeNull()
  }
})
