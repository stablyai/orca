import { expect, it } from 'vitest'
import { apnsBody } from './apns-client.js'
import { fcmMessageBody } from './fcm-client.js'
import { buildPushDelivery } from './push-delivery-message.js'

it('dismissal provider payloads cannot display a new alert or play a sound', () => {
  const delivery = buildPushDelivery({
    expiresAt: Date.now() + 300_000,
    registrationId: 'reg',
    hostFingerprint: 'host',
    notification: {
      kind: 'dismiss',
      notificationId: 'note',
      notificationSeq: 2,
      notificationEpoch: 'epoch',
      source: 'agent-task-complete',
      agentState: null,
      title: 'Orca',
      body: ''
    }
  })
  expect(JSON.parse(apnsBody(delivery)).aps).toEqual({ 'content-available': 1 })
  const android = JSON.parse(fcmMessageBody({ delivery, token: 'test', channelId: 'test' })).message
  expect(android).not.toHaveProperty('notification')
  expect(android.android).not.toHaveProperty('notification')
  expect(android.android).not.toHaveProperty('collapse_key')
  expect(android.data).not.toHaveProperty('title')
  expect(android.data).not.toHaveProperty('message')
  expect(android.data).not.toHaveProperty('sound')
  expect(android.data.kind).toBe('dismiss')
})
