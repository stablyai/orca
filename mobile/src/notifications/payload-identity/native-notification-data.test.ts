import { expect, it } from 'vitest'
import { readNativeNotificationData } from './native-notification-data'

it('preserves the same chat identity in mapped and headless Android responses', () => {
  const payload = {
    hostFingerprint: 'paired-host-key',
    notificationId: 'notice-4',
    replyTarget: { type: 'chat', sessionId: 'conversation-4' }
  }
  expect(readNativeNotificationData({ content: { data: payload } })).toEqual(payload)
  expect(
    readNativeNotificationData({ content: { data: null, dataString: JSON.stringify(payload) } })
  ).toEqual(payload)
  expect(
    readNativeNotificationData({
      content: { data: null },
      trigger: { type: 'push', remoteMessage: { data: payload } }
    })
  ).toEqual(payload)
  expect(readNativeNotificationData({ content: { data: null, dataString: '{invalid' } })).toBeNull()
})
