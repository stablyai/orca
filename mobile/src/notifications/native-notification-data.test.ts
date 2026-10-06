import { expect, it } from 'vitest'
import { readNativeNotificationData } from './native-notification-data'
import { readOrcaPushPayload } from './push-payload'

it('reads actual Expo APNs payloads when content.data is null', () => {
  const orca = {
    hostFingerprint: 'qa-host',
    notificationId: 'done',
    notificationSeq: 4,
    notificationEpoch: 'epoch'
  }
  const data = readNativeNotificationData({
    content: { data: null },
    trigger: { type: 'push', payload: { aps: {}, orca } }
  })
  expect(readOrcaPushPayload(data)).toMatchObject(orca)
})
it('keeps Android push and local notification data', () => {
  const data = { hostId: 'host', notificationId: 'done' }
  expect(readNativeNotificationData({ content: { data }, trigger: { type: 'push' } })).toBe(data)
  expect(readNativeNotificationData({ content: { data }, trigger: null })).toBe(data)
})
